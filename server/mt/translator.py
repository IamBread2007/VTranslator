import base64
import io
import json
import math
import re
from collections.abc import Sequence
from dataclasses import dataclass

import httpx
from PIL import Image, ImageDraw, ImageFont

from .geometry import tile_ranges
from .schemas import Box

PROMPT_VERSION = "3"
MAX_EDGE = 1600
MAX_VISION_IMAGES = 12
JPEG_QUALITY = 85
TILE_OVERLAP = 200
RETRY_INSTRUCTION = "Return only valid JSON matching the required schema"

LANG_NAMES = {
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "en": "English",
    # Brazilian Portuguese: readers of manga in pt-BR expect this variety, so the
    # prompt asks for it rather than for European Portuguese.
    "pt": "Brazilian Portuguese",
    # Scanlations a reader calls "Mexican" use the Latin American register,
    # which differs from Castilian in pronouns and slang.
    "es": "Latin American Spanish",
    "id": "Indonesian",
    "vi": "Vietnamese",
}

SYSTEM_PROMPT = """You translate comics (manga, manhwa, manhua, webtoon).
You receive images of ONE page with numbered labels and the OCR text of each
labeled region. Rules:
- Use the visuals to understand context, emotion and who is speaking.
- If OCR text is clearly wrong and the image is readable, fix it before translating.
- For Vietnamese, choose pronouns (anh/em/tao/mày/cậu/tớ/...) that fit the
  characters' relationship and tone.
- Keep proper names consistent with the previous context.
- Translate concisely so the text fits inside its bubble.
- Keep a glossary of recurring names, terms and the address pronouns chosen for each
  speaker pair, so later pages stay consistent.
- Output ONLY JSON: {"translations":[{"id":<int>,"text":"<translation>"}],
  "glossary":[{"term":"<source>","translation":"<vi>","note":"<pronoun or context>"}]}
  with one translation per given id. "glossary" may be empty."""


class TranslationError(RuntimeError):
    pass


def resize_max_edge(img: Image.Image, max_edge: int = MAX_EDGE) -> Image.Image:
    longest = max(img.size)
    if longest <= max_edge:
        return img
    scale = max_edge / longest
    size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    return img.resize(size, Image.Resampling.LANCZOS)


def annotate_region(
    img: Image.Image, blocks: Sequence[tuple[int, Box]], y0: int = 0
) -> Image.Image:
    """Draw white-on-red id labels; `blocks` use page coords, `img` starts at y0."""
    out = img.convert("RGB")
    draw = ImageDraw.Draw(out)
    font_px = max(14, out.width // 40)
    font = ImageFont.load_default(size=font_px)
    # Outlines are drawn in a separate pass so no region edge covers an id label.
    stroke = max(2, out.width // 400)
    for _, box in blocks:
        draw.rectangle(
            (box.x, box.y - y0, box.x + box.w, box.y + box.h - y0),
            outline=(230, 30, 30),
            width=stroke,
        )
    for bid, box in blocks:
        label = str(bid)
        left, t, r, b = draw.textbbox((0, 0), label, font=font)
        lw, lh = r - left + 8, b - t + 6
        x = min(max(box.x, 0), max(out.width - lw, 0))
        top = box.y - y0
        # Prefer just above the box so OCR text stays visible.
        y = top - lh if top - lh >= 0 else max(top, 0)
        y = min(y, max(out.height - lh, 0))
        draw.rectangle((x, y, x + lw, y + lh), fill=(200, 0, 0), outline=(0, 0, 0))
        draw.text((x + 4 - left, y + 3 - t), label, fill=(255, 255, 255), font=font)
    return out


def build_som_image(
    page: Image.Image, blocks: Sequence[tuple[int, Box]]
) -> Image.Image:
    """One page image with a red outline and `[n]` label per region (Set-of-Mark).

    Labels let the model refer to a region by id from its position in the page,
    so it can tell speakers apart without reading the OCR text first. The longest
    edge is capped at MAX_EDGE so the page stays within the vision payload limit.
    """
    return resize_max_edge(annotate_region(page, blocks))


def _vertical_tiles(width: int, height: int) -> tuple[list[tuple[int, int]], bool]:
    ranges = tile_ranges(width, height)
    max_tiles = MAX_VISION_IMAGES - 1  # one slot is the overview
    if len(ranges) <= max_tiles:
        return ranges, False
    # Coarsen: fewer, taller tiles that still cover the whole page.
    step = math.ceil(height / max_tiles)
    coarse = [
        (i * step, min(height, i * step + step + TILE_OVERLAP))
        for i in range(max_tiles)
    ]
    coarse = [(a, b) for a, b in coarse if a < height]
    coarse[-1] = (coarse[-1][0], height)
    return coarse, True


def build_vision_images(
    page: Image.Image,
    blocks: Sequence[tuple[int, Box]],
    warnings: list[str] | None = None,
) -> list[Image.Image]:
    if page.height <= 3 * page.width:
        return [resize_max_edge(annotate_region(page, blocks))]
    images = [resize_max_edge(annotate_region(page, blocks))]  # global overview
    ranges, coarsened = _vertical_tiles(page.width, page.height)
    if coarsened and warnings is not None:
        warnings.append(
            f"vision tiles coarsened to {len(ranges)} to stay within {MAX_VISION_IMAGES} images"
        )
    for y0, y1 in ranges:
        tile = page.crop((0, y0, page.width, y1))
        inside = [(i, b) for i, b in blocks if y0 <= b.y + b.h / 2 < y1]
        images.append(resize_max_edge(annotate_region(tile, inside, y0=y0)))
    return images


def to_data_url(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=JPEG_QUALITY)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _glossary_dict(entry: object) -> dict[str, str]:
    """Glossary entry as a plain dict; the pipeline may hand over schema models.

    Duck-typed so this module keeps working with plain dicts (and with callers
    that pass the Pydantic model) without importing the schemas module.
    """
    if isinstance(entry, dict):
        return entry
    dump = getattr(entry, "model_dump", None)
    if callable(dump):
        return dump()
    return {
        "term": getattr(entry, "term", ""),
        "translation": getattr(entry, "translation", ""),
        "note": getattr(entry, "note", ""),
    }


def build_messages(
    images: Sequence[Image.Image],
    items: Sequence[tuple[int, str]],
    src: str,
    tgt: str,
    prev_context: Sequence[str],
    glossary: Sequence[dict[str, str]] = (),
) -> list[dict]:
    src_name = LANG_NAMES.get(src, src)
    tgt_name = LANG_NAMES.get(tgt, tgt)
    lines = [f"Translate from {src_name} to {tgt_name}."]
    if len(images) > 1:
        lines.append(
            "The first image may be a small overview of the whole page; the following"
            " images are vertical tiles of the SAME page. Region ids are global across"
            " all images."
        )
    if prev_context:
        lines.append("Previous context (earlier lines of this chapter):")
        lines.extend(f"- {c}" for c in list(prev_context)[-20:])
    if glossary:
        lines.append("Glossary from earlier pages (use these terms and pronouns):")
        lines.extend(
            f"- {g['term']} = {g['translation']}"
            + (f" ({g['note']})" if g.get("note") else "")
            for g in list(glossary)[-GLOSSARY_CAP:]
        )
    lines.append("OCR text per region (id: text):")
    lines.extend(f"{i}: {t}" for i, t in items)
    content: list[dict] = [{"type": "text", "text": "\n".join(lines)}]
    content.extend(
        {"type": "image_url", "image_url": {"url": to_data_url(im)}} for im in images
    )
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": content},
    ]


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def _extract_obj(raw: str) -> dict | None:
    candidates = [raw]
    candidates += _FENCE.findall(raw)
    start, end = raw.find("{"), raw.rfind("}")
    if 0 <= start < end:
        candidates.append(raw[start : end + 1])
    for c in candidates:
        try:
            obj = json.loads(c)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(obj, dict):
            return obj
    return None


def parse_translations(raw: str, valid_ids: set[int]) -> dict[int, str]:
    obj = _extract_obj(raw or "")
    entries = obj.get("translations") if obj else None
    if not isinstance(entries, list):
        return {}
    out: dict[int, str] = {}
    for e in entries:
        if not isinstance(e, dict):
            continue
        raw_id = e.get("id")
        if isinstance(raw_id, bool) or not isinstance(raw_id, (int, str)):
            continue
        try:
            bid = int(raw_id)
        except ValueError:
            continue
        text = e.get("text")
        if bid in valid_ids and isinstance(text, str) and text.strip():
            out[bid] = text.strip()
    return out


GLOSSARY_CAP = 30


@dataclass(frozen=True)
class TranslationResult:
    translations: dict[int, str]
    glossary: list[dict[str, str]]


def _result(raw: str, valid: set[int]) -> TranslationResult:
    """One reply yields both halves; a reply with no glossary still yields its translations."""
    return TranslationResult(
        translations=parse_translations(raw, valid),
        glossary=parse_glossary(raw),
    )


def parse_glossary(raw: str) -> list[dict[str, str]]:
    """Glossary entries from a translation reply, capped and type-checked.

    A reply without a glossary (older prompt or translations-only output) yields
    an empty list, so glossary loss never fails a translation. Entries whose term
    or translation is not a string are dropped so the stored context stays clean.
    """
    obj = _extract_obj(raw or "")
    entries = obj.get("glossary") if obj else None
    if not isinstance(entries, list):
        return []
    out: list[dict[str, str]] = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        term, tr = e.get("term"), e.get("translation")
        if not (isinstance(term, str) and isinstance(tr, str) and term.strip()):
            continue
        note = e.get("note")
        out.append(
            {
                "term": term.strip(),
                "translation": tr.strip(),
                "note": note.strip() if isinstance(note, str) else "",
            }
        )
        if len(out) == GLOSSARY_CAP:
            break
    return out


class LlmTranslator:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        timeout_s: float = 90.0,
        client: httpx.Client | None = None,
        async_client: httpx.AsyncClient | None = None,
    ):
        self.url = base_url.rstrip("/") + "/chat/completions"
        self._api_key = api_key
        self.model = model
        self.timeout_s = timeout_s
        self._client = client or httpx.Client()
        self._async_client = async_client or httpx.AsyncClient()

    @staticmethod
    def _content(r: httpx.Response) -> str:
        if r.status_code != 200:
            raise TranslationError(f"LLM HTTP {r.status_code}: {r.text[:200]}")
        try:
            content = r.json()["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as e:
            raise TranslationError(f"LLM bad response: {r.text[:200]}") from e
        return content if isinstance(content, str) else ""

    def _body(self, messages: list[dict]) -> dict:
        return {"model": self.model, "messages": messages, "temperature": 0.3}

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._api_key}"}

    def _complete(self, messages: list[dict]) -> str:
        try:
            r = self._client.post(
                self.url,
                headers=self._headers(),
                json=self._body(messages),
                timeout=self.timeout_s,
            )
        except httpx.HTTPError as e:
            raise TranslationError(f"LLM network error: {type(e).__name__}") from e
        return self._content(r)

    async def _complete_async(self, messages: list[dict]) -> str:
        # Only httpx.HTTPError is caught. CancelledError is a BaseException and is
        # deliberately allowed through: the whole point of this path is that
        # cancelling the task tears down the outbound request. Converting it to
        # TranslationError would make a user-requested stop indistinguishable
        # from a genuine failure, and the page would be marked errored.
        try:
            r = await self._async_client.post(
                self.url,
                headers=self._headers(),
                json=self._body(messages),
                timeout=self.timeout_s,
            )
        except httpx.HTTPError as e:
            raise TranslationError(f"LLM network error: {type(e).__name__}") from e
        return self._content(r)

    def _finish(
        self, raw: str, messages: list[dict], valid: set[int]
    ) -> TranslationResult:
        if _extract_obj(raw) is not None:
            return _result(raw, valid)
        retry = [
            *messages,
            {"role": "assistant", "content": raw},
            {"role": "user", "content": RETRY_INSTRUCTION},
        ]
        return _result(self._complete(retry), valid)

    def translate(
        self,
        page: Image.Image,
        items: Sequence[tuple[int, Box, str]],
        src: str,
        tgt: str,
        prev_context: Sequence[str],
        warnings: list[str] | None = None,
        glossary: Sequence[dict[str, str]] = (),
    ) -> dict[int, str]:
        return self.translate_full(
            page, items, src, tgt, prev_context, warnings, glossary
        ).translations

    def translate_full(
        self,
        page: Image.Image,
        items: Sequence[tuple[int, Box, str]],
        src: str,
        tgt: str,
        prev_context: Sequence[str],
        warnings: list[str] | None = None,
        glossary: Sequence[dict[str, str]] = (),
    ) -> TranslationResult:
        glossary = [_glossary_dict(g) for g in glossary]
        if not items:
            return TranslationResult(translations={}, glossary=[])
        images = build_vision_images(page, [(i, b) for i, b, _ in items], warnings)
        messages = build_messages(
            images, [(i, t) for i, _, t in items], src, tgt, prev_context, glossary
        )
        valid = {i for i, _, _ in items}
        return self._finish(self._complete(messages), messages, valid)

    async def translate_async(
        self,
        page: Image.Image,
        items: Sequence[tuple[int, Box, str]],
        src: str,
        tgt: str,
        prev_context: Sequence[str],
        warnings: list[str] | None = None,
        glossary: Sequence[dict[str, str]] = (),
    ) -> dict[int, str]:
        """Cancellable counterpart of `translate`.

        Awaiting an AsyncClient request means cancelling the task aborts the
        socket, which is what stops the provider continuing to bill for tokens.
        """
        result = await self.translate_async_full(
            page, items, src, tgt, prev_context, warnings, glossary
        )
        return result.translations

    async def translate_async_full(
        self,
        page: Image.Image,
        items: Sequence[tuple[int, Box, str]],
        src: str,
        tgt: str,
        prev_context: Sequence[str],
        warnings: list[str] | None = None,
        glossary: Sequence[dict[str, str]] = (),
    ) -> TranslationResult:
        glossary = [_glossary_dict(g) for g in glossary]
        if not items:
            return TranslationResult(translations={}, glossary=[])
        images = build_vision_images(page, [(i, b) for i, b, _ in items], warnings)
        messages = build_messages(
            images, [(i, t) for i, _, t in items], src, tgt, prev_context, glossary
        )
        valid = {i for i, _, _ in items}
        raw = await self._complete_async(messages)
        if _extract_obj(raw) is not None:
            return _result(raw, valid)
        retry = [
            *messages,
            {"role": "assistant", "content": raw},
            {"role": "user", "content": RETRY_INSTRUCTION},
        ]
        return _result(await self._complete_async(retry), valid)
