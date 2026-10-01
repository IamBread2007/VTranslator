"""Page pipeline: detect → resolve lang → OCR → style (original) → inpaint → LLM.

Two cache stages: perception (everything before the LLM) and translation.
"""

import base64
import io
import logging
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from PIL import Image, UnidentifiedImageError

from .cache import StageCache, make_key, normalize_context
from .geometry import contains, sort_reading_order
from .ocr import (
    OcrEngine,
    choose_engine,
    crop_with_padding,
    make_probe,
    resolve_source_lang,
    select_probe_crops,
)
from .schemas import Block, Box, Style, TranslateOptions, TranslateResponse
from .translator import PROMPT_VERSION

PIPELINE_VERSION = "2"
BUBBLE_SHRINK = 0.12
TEXT_KINDS = ("text_bubble", "text_free")

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


StyleFn = Callable[[Image.Image, Box, str, int], Style]


def shrink_box(box: Box, frac: float = BUBBLE_SHRINK) -> Box:
    dx, dy = int(box.w * frac), int(box.h * frac)
    return Box(x=box.x + dx, y=box.y + dy, w=box.w - 2 * dx, h=box.h - 2 * dy)


def _png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


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
        texts = [(b, k) for b, k, _ in found if k in TEXT_KINDS]
        if not texts:
            lang = requested if requested != "auto" else "ja"
            meta = {"lang": lang, "warnings": ["no text detected"], "blocks": []}
            return meta, _png_bytes(page)

        probe_boxes = select_probe_crops([b for b, _ in texts], page.height)
        crops = [crop_with_padding(page, b) for b in probe_boxes]
        res = resolve_source_lang(
            crops,
            requested,
            primary=make_probe("paddle:v5", self.get_ocr),
            korean=make_probe("paddle:korean", self.get_ocr),
        )
        engine = self.get_ocr(choose_engine(self.ocr_engine, res.lang))

        read: list[tuple[Box, str, str]] = []
        for box, kind in texts:
            text = engine.read(crop_with_padding(page, box)).text.strip()
            if text:
                read.append((box, kind, text))

        order = sort_reading_order([b for b, _, _ in read], rtl=res.lang == "ja")
        blocks: list[dict] = []
        for n, idx in enumerate(order, start=1):
            box, kind, text = read[idx]
            parent = next((bb for bb in bubbles if contains(bb, box)), None)
            render = shrink_box(parent) if parent else box
            # Style MUST be measured on the original page, before inpainting.
            style = self.style_estimator(page, box, kind, text.count("\n") + 1)
            blocks.append(
                {
                    "id": n,
                    "box": box.model_dump(),
                    "render_box": render.model_dump(),
                    "kind": kind,
                    "source": text,
                    "style": style.model_dump(),
                }
            )

        if blocks:
            inpainted = self.inpainter.inpaint(page, [(b, k) for b, k, _ in read])
        else:
            inpainted = page
        meta = {"lang": res.lang, "warnings": res.warnings, "blocks": blocks}
        return meta, _png_bytes(inpainted)

    # ---------- full run ----------

    def run(self, image_bytes: bytes, opts: TranslateOptions) -> TranslateResponse:
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
            with self._infer_lock:
                cached = self._perceive(page, opts.source_lang)
            self.cache.put_perception(p_key, *cached)
        meta, png = cached

        lang: str = meta["lang"]
        warnings: list[str] = list(meta.get("warnings", []))
        raw_blocks: list[dict] = meta["blocks"]
        translations: dict[int, str] = {}
        t_hit = None

        if raw_blocks:
            ctx = normalize_context(opts.prev_context)
            t_key = make_key(
                "translation",
                p_key,
                lang,
                opts.target_lang,
                self.llm_model,
                PROMPT_VERSION,
                ctx,
            )
            stored = self.cache.get_translation(t_key)
            t_hit = stored is not None
            if stored is not None:
                translations = {int(k): v for k, v in stored.items()}
            else:
                items = [(b["id"], Box(**b["box"]), b["source"]) for b in raw_blocks]
                translations = self.translator.translate(
                    page, items, lang, opts.target_lang, ctx, warnings=warnings
                )
                self.cache.put_translation(
                    t_key, {str(k): v for k, v in translations.items()}
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
        )
