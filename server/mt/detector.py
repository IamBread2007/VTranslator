import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForObjectDetection

from .geometry import merge_boxes, tile_ranges
from .schemas import Box

MODEL_ID = "ogkalu/comic-text-and-bubble-detector"
LABELS = {0: "bubble", 1: "text_bubble", 2: "text_free"}


class ComicDetector:
    def __init__(self, threshold: float = 0.3, device: str | None = None):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.processor = AutoImageProcessor.from_pretrained(MODEL_ID)
        self.model = (
            AutoModelForObjectDetection.from_pretrained(MODEL_ID).to(self.device).eval()
        )
        self.threshold = threshold

    @torch.inference_mode()
    def detect(self, img: Image.Image) -> list[tuple[Box, str, float]]:
        found: list[tuple[Box, int, float]] = []
        for y0, y1 in tile_ranges(img.width, img.height):
            tile = img.crop((0, y0, img.width, y1))
            inputs = self.processor(images=tile, return_tensors="pt").to(self.device)
            out = self.model(**inputs)
            res = self.processor.post_process_object_detection(
                out,
                target_sizes=torch.tensor([[tile.height, tile.width]]),
                threshold=self.threshold,
            )[0]
            boxes = res["boxes"].tolist()
            labels = res["labels"].tolist()
            scores = res["scores"].tolist()
            for (x0, ty0, x1, ty1), lbl, sc in zip(boxes, labels, scores, strict=True):
                box = Box(x=int(x0), y=int(ty0) + y0, w=int(x1 - x0), h=int(ty1 - ty0))
                found.append((box, int(lbl), float(sc)))
        return [(b, LABELS[lbl], s) for b, lbl, s in merge_boxes(found, iou_thr=0.5)]
