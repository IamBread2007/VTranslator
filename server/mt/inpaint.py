from collections.abc import Sequence

import cv2
import numpy as np
from PIL import Image

from .schemas import Box

DILATE_PX = 3
LAMA_PAD = 32


def _clip(box: Box, w: int, h: int) -> tuple[int, int, int, int]:
    x0, y0 = max(box.x, 0), max(box.y, 0)
    x1, y1 = min(box.x + box.w, w), min(box.y + box.h, h)
    return x0, y0, x1, y1


def _drop_border_components(m: np.ndarray) -> np.ndarray:
    """Remove ink components that touch the ROI edge and span most of it.

    A bubble outline or panel border crosses the crop edge and reads as a huge
    ink component. Real glyphs are small and interior, so anything touching an
    edge while spanning over 60% of that edge is structure, not text.
    """
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    h, w = m.shape
    out = m.copy()
    for lbl in range(1, n):
        x, y, cw, ch, _ = stats[lbl]
        touches_x = (y == 0 or y + ch == h) and cw > 0.6 * w
        touches_y = (x == 0 or x + cw == w) and ch > 0.6 * h
        if touches_x or touches_y:
            out[labels == lbl] = 0
    return out


def _fix_polarity(m: np.ndarray) -> np.ndarray:
    """Orient a THRESH_BINARY_INV ROI mask so its white marks text, not ground.

    `m` marks the ROI's dark side. The ROI border is background, so the class
    covering it is the background's: a mostly bright border means dark glyphs on
    light ground and Otsu already has the mask the right way round, while a
    mostly dark border means the glyphs are the light side and it is back to
    front. Ink can cover most of a dense box, so only the border decides; a
    fifty-fifty border, or none at all, carries no evidence and falls back to
    the old rule that ink is the minority.
    """
    border = np.zeros_like(m, dtype=bool)
    border[[0, -1], :] = True
    border[:, [0, -1]] = True
    total = int(np.count_nonzero(border))
    bright = total - int(np.count_nonzero(m[border]))
    if not total or 2 * bright == total:
        return cv2.bitwise_not(m) if np.count_nonzero(m) > m.size / 2 else m
    return cv2.bitwise_not(m) if 2 * bright < total else m


def text_mask(page: Image.Image, boxes: Sequence[Box]) -> np.ndarray:
    """uint8 HxW mask (0/255) of text strokes inside `boxes` (Otsu + dilate)."""
    gray = np.asarray(page.convert("L"))
    h, w = gray.shape
    mask = np.zeros((h, w), np.uint8)
    for box in boxes:
        x0, y0, x1, y1 = _clip(box, w, h)
        if x1 <= x0 or y1 <= y0:
            continue
        roi = gray[y0:y1, x0:x1]
        _, m = cv2.threshold(roi, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        m = _fix_polarity(m)
        m = _drop_border_components(m)
        region = mask[y0:y1, x0:x1]
        mask[y0:y1, x0:x1] = np.bitwise_or(region, np.asarray(m, np.uint8))
    kernel = np.ones((2 * DILATE_PX + 1, 2 * DILATE_PX + 1), np.uint8)
    return cv2.dilate(mask, kernel)


def _telea(page: Image.Image, mask: np.ndarray) -> Image.Image:
    if not mask.any():
        return page.convert("RGB")
    src = np.asarray(page.convert("RGB"))
    out = cv2.inpaint(src, mask, 3, cv2.INPAINT_TELEA)
    return Image.fromarray(out)


class OpenCvInpainter:
    def inpaint(
        self, page: Image.Image, blocks: Sequence[tuple[Box, str]]
    ) -> Image.Image:
        return _telea(page, text_mask(page, [b for b, _ in blocks]))


class LamaInpainter:
    """LaMa for `text_free` (text over art); TELEA for bubbles."""

    def __init__(self):
        # Optional extra (INPAINTER=lama): pip install simple-lama-inpainting
        from simple_lama_inpainting import (  # pyright: ignore[reportMissingImports]
            SimpleLama,
        )

        self._lama = SimpleLama()

    def inpaint(
        self, page: Image.Image, blocks: Sequence[tuple[Box, str]]
    ) -> Image.Image:
        bubbles = [b for b, k in blocks if k != "text_free"]
        out = _telea(page, text_mask(page, bubbles))
        for box, kind in blocks:
            if kind != "text_free":
                continue
            m = text_mask(out, [box])
            if not m.any():
                continue
            pad = Box(
                x=box.x - LAMA_PAD,
                y=box.y - LAMA_PAD,
                w=box.w + 2 * LAMA_PAD,
                h=box.h + 2 * LAMA_PAD,
            )
            x0, y0, x1, y1 = _clip(pad, out.width, out.height)
            crop = out.crop((x0, y0, x1, y1))
            crop_mask = Image.fromarray(m[y0:y1, x0:x1])
            filled = self._lama(crop, crop_mask).convert("RGB")
            # LaMa may pad to a multiple of 8; trim back to the crop size.
            out.paste(filled.crop((0, 0, x1 - x0, y1 - y0)), (x0, y0))
        return out


def get_inpainter(name: str) -> OpenCvInpainter | LamaInpainter:
    return LamaInpainter() if name == "lama" else OpenCvInpainter()
