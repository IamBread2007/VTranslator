"""Page pipeline: detect → resolve lang → OCR → style (original) → inpaint → LLM.

Two cache stages: perception (everything before the LLM) and translation.
"""

import asyncio
import base64
import io
import logging
import threading
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, Protocol

from PIL import Image, UnidentifiedImageError

from .cache import StageCache, make_key, normalize_context
from .geometry import contains, sort_reading_order
from .inpaint import text_mask
from .ocr import (
    OcrEngine,
    choose_engine,
    crop_with_padding,
    is_junk,
    make_probe,
    read_crop,
    resolve_source_lang,
    select_probe_crops,
)
from .schemas import (
    Block,
    Box,
    GlossaryEntry,
    Style,
    TranslateOptions,
    TranslateResponse,
)
from .translator import GLOSSARY_CAP, PROMPT_VERSION, TranslationResult

# v3: PP-OCRv5 mobile det/rec replaced server models (CPU speed), CUDA torch.
# v4: pt added, which routes to latin_PP-OCRv5_mobile_rec instead of the
#     chinese-dict probe; v3 perception entries for pt pages use the wrong model.
# v8: blocks carry measured slice widths, so v7 perception entries are stale.
PIPELINE_VERSION = "8"
BUBBLE_SHRINK = 0.12
TEXT_KINDS = ("text_bubble", "text_free")

# Contour profile: how many horizontal slices measure each bubble, how much
# clearance each measured side keeps from the outline, and what counts as
# outline ink on the cleaned page (see slice_widths).
SLICE_COUNT = 12
SLICE_MARGIN_PX = 6
SLICE_BORDER_LUMA = 128

log = logging.getLogger("mt.pipeline")


class ImageTooLargeError(ValueError):
    pass


class UnsupportedImageError(ValueError):
    pass


class Detector(Protocol):
    def detect(self, img: Image.Image) -> list[tuple[Box, str, float]]: ...


class Inpainter(Protocol):
    def inpaint(
        self, page: Image.Image, blocks: list[tuple[Box, str]]
    ) -> Image.Image: ...


class Translator(Protocol):
    def translate(
        self,
        page: Image.Image,
        items: list[tuple[int, Box, str]],
        src: str,
        tgt: str,
        prev_context: list[str],
        warnings: list[str] | None = None,
    ) -> dict[int, str]: ...


StyleFn = Callable[..., Style]


def shrink_box(box: Box, frac: float = BUBBLE_SHRINK) -> Box:
    dx, dy = int(box.w * frac), int(box.h * frac)
    return Box(x=box.x + dx, y=box.y + dy, w=box.w - 2 * dx, h=box.h - 2 * dy)


def slice_widths(
    clean: Image.Image, box: Box, bubble: Box | None
) -> list[float] | None:
    """Twelve bubble widths across `box`, each normalised to `box.w`.

    `clean` is the grayscale page after inpainting: the text is gone, so at each
    slice's centre line the first dark pixel met while scanning outward from the
    bubble's centre is the bubble outline, however irregular its shape. Each
    side keeps `SLICE_MARGIN_PX` of clearance from that outline so the client
    never lets a glyph touch the border. Returns None for a block with no
    containing bubble, the client's cue to keep its shape fallback.
    """
    if bubble is None or box.w <= 0 or box.h <= 0:
        return None

    px = clean.load()
    left_limit = max(0, bubble.x)
    right_limit = min(clean.width - 1, bubble.x + bubble.w - 1)
    cx = min(max(bubble.x + bubble.w // 2, left_limit), right_limit)

    widths: list[float] = []
    for i in range(SLICE_COUNT):
        y = box.y + (2 * i + 1) * box.h // (2 * SLICE_COUNT)
        y = min(max(y, 0), clean.height - 1)
        left = cx
        while left > left_limit and px[left - 1, y] >= SLICE_BORDER_LUMA:
            left -= 1
        right = cx
        while right < right_limit and px[right + 1, y] >= SLICE_BORDER_LUMA:
            right += 1
        span = right - left + 1 - 2 * SLICE_MARGIN_PX
        widths.append(min(1.0, max(0.0, span / box.w)))
    return widths


def _png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _as_entry(entry: GlossaryEntry | dict[str, str]) -> GlossaryEntry:
    """LLM replies carry glossary entries as dicts; the response holds models."""
    return entry if isinstance(entry, GlossaryEntry) else GlossaryEntry(**entry)


class Pipeline:
    def __init__(
        self,
        *,
        detector: Detector,
        get_ocr: Callable[[str], OcrEngine],
        translator: Translator,
        style_estimator: StyleFn,
        inpainter: Inpainter,
        cache_dir: str | Path,
        ocr_engine: str,
        llm_model: str,
        perception_config: dict[str, Any],
        max_image_bytes: int,
        max_dimension: int,
        max_pixels: int,
    ):
        self.detector = detector
        self.get_ocr = get_ocr
        self.translator = translator
        self.style_estimator = style_estimator
        self.inpainter = inpainter
        self.cache = StageCache(cache_dir)
        self.ocr_engine = ocr_engine
        self.llm_model = llm_model
        self.perception_config = perception_config
        self.max_image_bytes = max_image_bytes
        self.max_dimension = max_dimension
        self.max_pixels = max_pixels
        # Models (torch/paddle) are not guaranteed thread-safe; LLM call is
        # outside this lock.
        self._infer_lock = threading.Lock()

    # ---------- steps 1–2: image safety ----------

    def _open(self, data: bytes) -> Image.Image:
        if len(data) > self.max_image_bytes:
            raise ImageTooLargeError(f"image exceeds {self.max_image_bytes} bytes")
        try:
            img = Image.open(io.BytesIO(data))
            w, h = img.size  # header only, not decoded yet
        except Image.DecompressionBombError as e:
            raise ImageTooLargeError(str(e)) from e
        except (UnidentifiedImageError, OSError) as e:
            raise UnsupportedImageError("unsupported image") from e
        if max(w, h) > self.max_dimension or w * h > self.max_pixels:
            raise ImageTooLargeError(f"image {w}x{h} exceeds limits")
        try:
            img.load()
            return img.convert("RGB")
        except (OSError, ValueError) as e:
            raise UnsupportedImageError("cannot decode image") from e

    # ---------- steps 5–11: perception ----------

    def _perceive(self, page: Image.Image, requested: str) -> tuple[dict, bytes]:
        found = self.detector.detect(page)
        bubbles = [b for b, k, _ in found if k == "bubble"]
        texts = [(b, k, s) for b, k, s in found if k in TEXT_KINDS]
        if not texts:
            lang = requested if requested != "auto" else "ja"
            meta = {"lang": lang, "warnings": ["no text detected"], "blocks": []}
            return meta, _png_bytes(page)

        probe_boxes = select_probe_crops([b for b, _, _ in texts], page.height)
        crops = [crop_with_padding(page, b) for b in probe_boxes]
        res = resolve_source_lang(
            crops,
            requested,
            primary=make_probe("paddle:v5", self.get_ocr),
            korean=make_probe("paddle:korean", self.get_ocr),
        )
        engine = self.get_ocr(choose_engine(self.ocr_engine, res.lang))

        read: list[tuple[Box, str, str]] = []
        for box, kind, score in texts:
            text = read_crop(engine, page, box).text.strip()
            if text and not is_junk(text, kind, score):
                read.append((box, kind, text))

        order = sort_reading_order([b for b, _, _ in read], rtl=res.lang == "ja")
        # Glyph pixels come from the mask, computed once per page on the original image.
        page_mask = text_mask(page, [b for b, _, _ in read])
        # Style MUST be measured on the original page, before inpainting; the
        # mask only selects which pixels inside that page are glyphs. Every style
        # is sampled in this pass, before the inpainter touches the page, so no
        # style can come from a cleaned pixel.
        styles: dict[int, Style] = {}
        for idx in order:
            box, kind, text = read[idx]
            styles[idx] = self.style_estimator(
                page, box, kind, text.count("\n") + 1, mask_roi=page_mask
            )

        if read:
            inpainted = self.inpainter.inpaint(page, [(b, k) for b, k, _ in read])
        else:
            inpainted = page
        # Slice widths are measured on the cleaned page, not the original: with
        # the glyphs gone, the outline is the only ink a scan can meet.
        clean = inpainted.convert("L")
        blocks: list[dict] = []
        for n, idx in enumerate(order, start=1):
            box, kind, text = read[idx]
            parent = next((bb for bb in bubbles if contains(bb, box)), None)
            render = shrink_box(parent) if parent else box
            blocks.append(
                {
                    "id": n,
                    "box": box.model_dump(),
                    "render_box": render.model_dump(),
                    "kind": kind,
                    "source": text,
                    "style": styles[idx].model_dump(),
                    "slice_widths": slice_widths(clean, box, parent),
                }
            )
        meta = {"lang": res.lang, "warnings": res.warnings, "blocks": blocks}
        return meta, _png_bytes(inpainted)

    # ---------- full run ----------

    def _perceive_locked(self, page: Image.Image, requested: str) -> tuple[dict, bytes]:
        # The inference lock is acquired inside the worker thread. Holding it on
        # the event loop would stall the disconnect watcher for the whole
        # perception, which is precisely when a Stop needs to be noticed.
        with self._infer_lock:
            return self._perceive(page, requested)

    async def _translate_async(
        self,
        page: Image.Image,
        items: list[tuple[int, Box, str]],
        lang: str,
        tgt: str,
        ctx: list[str],
        warnings: list[str],
        glossary: Sequence[GlossaryEntry | dict[str, str]] = (),
    ) -> TranslationResult:
        # A translator that implements the async path can be cancelled mid-request,
        # which is what stops the provider generating and billing further tokens.
        # One that does not is pushed to a thread so the event loop keeps running.
        full_async = getattr(self.translator, "translate_async_full", None)
        if full_async is not None:
            result = await full_async(
                page, items, lang, tgt, ctx, warnings=warnings, glossary=glossary
            )
            return TranslationResult(
                translations=result.translations,
                glossary=[_as_entry(g) for g in result.glossary],
            )
        full_sync = getattr(self.translator, "translate_full", None)
        if full_sync is not None:
            result = await asyncio.to_thread(
                full_sync,
                page,
                items,
                lang,
                tgt,
                ctx,
                warnings=warnings,
                glossary=glossary,
            )
            return TranslationResult(
                translations=result.translations,
                glossary=[_as_entry(g) for g in result.glossary],
            )
        # Translators written before the glossary exist only return the
        # translations half, so there is nothing to feed to the next page.
        async_call = getattr(self.translator, "translate_async", None)
        if async_call is not None:
            tr = await async_call(page, items, lang, tgt, ctx, warnings=warnings)
            return TranslationResult(translations=tr, glossary=[])
        tr = await asyncio.to_thread(
            self.translator.translate,
            page,
            items,
            lang,
            tgt,
            ctx,
            warnings=warnings,
        )
        return TranslationResult(translations=tr, glossary=[])

    def run(self, image_bytes: bytes, opts: TranslateOptions) -> TranslateResponse:
        # Single implementation, two entry points: the CLI and the existing tests
        # stay synchronous, and the HTTP handler awaits the cancellable one.
        return asyncio.run(self.run_async(image_bytes, opts))

    async def run_async(
        self, image_bytes: bytes, opts: TranslateOptions
    ) -> TranslateResponse:
        t0 = time.perf_counter()
        page = self._open(image_bytes)

        p_key = make_key(
            "perception",
            PIPELINE_VERSION,
            make_key(image_bytes.hex()),
            opts.source_lang,
            self.ocr_engine,
            self.perception_config,
        )
        cached = self.cache.get_perception(p_key)
        p_hit = cached is not None
        if cached is None:
            # Perception is CPU-bound, so it runs in a thread and a cancel cannot
            # kill it mid-inference. The checkpoint sits *before* it starts, so a
            # stop already requested is honoured without spending the work; a stop
            # arriving during it is honoured at the next checkpoint below.
            await asyncio.sleep(0)
            cached = await asyncio.to_thread(
                self._perceive_locked, page, opts.source_lang
            )
            self.cache.put_perception(p_key, *cached)
        meta, png = cached

        lang: str = meta["lang"]
        warnings: list[str] = list(meta.get("warnings", []))
        raw_blocks: list[dict] = meta["blocks"]
        translations: dict[int, str] = {}
        glossary: list[GlossaryEntry] = []
        t_hit = None

        if raw_blocks:
            ctx = normalize_context(opts.prev_context)
            # A previous page can hand over more terms than the prompt should carry.
            glossary_in = list(opts.glossary[-GLOSSARY_CAP:])
            t_key = make_key(
                "translation",
                p_key,
                lang,
                opts.target_lang,
                self.llm_model,
                PROMPT_VERSION,
                ctx,
                # The glossary changes the translation, so it belongs in the key.
                [g.model_dump() for g in glossary_in],
            )
            stored = self.cache.get_translation(t_key)
            t_hit = stored is not None
            if stored is not None:
                translations = {int(k): v for k, v in stored["translations"].items()}
                glossary = [GlossaryEntry(**g) for g in stored["glossary"]]
            else:
                # Everything above was free. This is the point where the run
                # starts costing money, so it is the last checkpoint before it.
                await asyncio.sleep(0)
                items = [(b["id"], Box(**b["box"]), b["source"]) for b in raw_blocks]
                result = await self._translate_async(
                    page,
                    items,
                    lang,
                    opts.target_lang,
                    ctx,
                    warnings,
                    glossary_in,
                )
                translations = result.translations
                glossary = result.glossary
                # Written only after a completed translation, so a cancelled run
                # leaves nothing that a later read could mistake for a hit.
                self.cache.put_translation(
                    t_key,
                    {
                        "translations": {str(k): v for k, v in translations.items()},
                        "glossary": [g.model_dump() for g in glossary],
                    },
                )

        blocks: list[Block] = []
        for b in raw_blocks:
            tr = translations.get(b["id"])
            if not tr:
                warnings.append(f"missing translation for id {b['id']}")
                tr = b["source"]
            blocks.append(Block(**b, translation=tr))

        log.info(
            "translate %.2fs perception_hit=%s translation_hit=%s blocks=%d",
            time.perf_counter() - t0,
            p_hit,
            t_hit,
            len(blocks),
        )
        return TranslateResponse(
            width=page.width,
            height=page.height,
            inpainted_png=base64.b64encode(png).decode("ascii"),
            resolved_source_lang=lang,  # type: ignore[arg-type]
            blocks=blocks,
            warnings=warnings,
            glossary=glossary,
        )
