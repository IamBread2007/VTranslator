"""Run the local server: `python -m mt` (reads settings from env / .env)."""

import logging
import threading

import uvicorn
from PIL import Image

from .app import create_app
from .config import Settings
from .detector import MODEL_ID, ComicDetector
from .inpaint import LamaInpainter, OpenCvInpainter
from .ocr import get_engine
from .pipeline import Pipeline
from .schemas import Box
from .style import estimate_style
from .translator import LlmTranslator

DETECTOR_THRESHOLD = 0.3


class LazyDetector:
    """Loads the RT-DETR model on first request, not at import/startup."""

    def __init__(self, threshold: float):
        self.threshold = threshold
        self._det: ComicDetector | None = None
        self._lock = threading.Lock()

    def detect(self, img: Image.Image) -> list[tuple[Box, str, float]]:
        with self._lock:
            if self._det is None:
                self._det = ComicDetector(threshold=self.threshold)
        return self._det.detect(img)


class LazyLama:
    """LaMa (optional extra dependency) loaded on first request."""

    def __init__(self):
        self._impl: LamaInpainter | None = None

    def inpaint(self, page: Image.Image, blocks: list[tuple[Box, str]]) -> Image.Image:
        if self._impl is None:
            self._impl = LamaInpainter()
        return self._impl.inpaint(page, blocks)


def build_pipeline(s: Settings) -> Pipeline:
    if s.style_engine != "kmeans":
        # YuzuMarker is Task 6 Step 5 (optional, not implemented yet).
        raise SystemExit(f"STYLE_ENGINE={s.style_engine} not supported; use kmeans")
    inpainter = LazyLama() if s.inpainter == "lama" else OpenCvInpainter()
    return Pipeline(
        detector=LazyDetector(DETECTOR_THRESHOLD),
        get_ocr=get_engine,
        translator=LlmTranslator(
            s.llm_base_url, s.llm_api_key, s.llm_model, timeout_s=s.llm_timeout_s
        ),
        style_estimator=estimate_style,
        inpainter=inpainter,
        cache_dir=s.cache_dir,
        ocr_engine=s.ocr_engine,
        llm_model=s.llm_model,
        perception_config={
            "detector": MODEL_ID,
            "threshold": DETECTOR_THRESHOLD,
            "ocr_engine": s.ocr_engine,
            "ocr_version": "PP-OCRv5-mobile",
            "style_engine": s.style_engine,
            "inpainter": s.inpainter,
        },
        max_image_bytes=s.max_image_bytes,
        max_dimension=s.max_dimension,
        max_pixels=s.max_pixels,
    )


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    # Required fields come from env/.env; pyright can't see pydantic-settings sources.
    s = Settings()  # pyright: ignore[reportCallIssue]
    app = create_app(s, pipeline=build_pipeline(s))
    uvicorn.run(app, host=s.host, port=s.port)


if __name__ == "__main__":
    main()
