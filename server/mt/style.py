import cv2
import numpy as np
from PIL import Image

from .schemas import Box, Style

SNAP_DIST = 40.0
DARK_LUMA = 0.4


def _hex(rgb: np.ndarray) -> str:
    r, g, b = (round(float(c)) for c in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def _snap(rgb: np.ndarray) -> np.ndarray:
    """Snap near-black / near-white colours to pure black / white."""
    if np.linalg.norm(rgb - 0.0) < SNAP_DIST:
        return np.zeros(3)
    if np.linalg.norm(rgb - 255.0) < SNAP_DIST:
        return np.full(3, 255.0)
    return np.clip(rgb, 0, 255)


def _luma(rgb: np.ndarray) -> float:
    r, g, b = (float(c) / 255.0 for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _two_colors(crop: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    """Return (text_color, background_color) via 2-cluster k-means."""
    px = np.asarray(crop.convert("RGB"), dtype=np.float32).reshape(-1, 3)
    if len(px) < 2 or np.allclose(px, px[0]):
        c = px[0] if len(px) else np.zeros(3, np.float32)
        return c, c
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
    best = np.zeros((len(px), 1), np.int32)  # ignored without USE_INITIAL_LABELS
    _, labels, centers = cv2.kmeans(px, 2, best, criteria, 3, cv2.KMEANS_PP_CENTERS)
    counts = np.bincount(labels.ravel(), minlength=2)
    fg = int(np.argmin(counts))  # fewer pixels = text strokes
    return centers[fg], centers[1 - fg]


def _mask_colors(
    rgb: np.ndarray, mask: np.ndarray
) -> tuple[np.ndarray, np.ndarray] | None:
    """Glyph fill and surround colours from a text mask, or None if the mask is empty.

    Erosion trims anti-aliased edges so the fill is pure glyph colour. A 1px stroke
    vanishes under erosion, so the un-eroded mask is the fallback. The surround is
    a ring just outside the glyphs, so it excludes the glyph and any stroke inside.
    """
    binary = (mask > 0).astype(np.uint8)
    if not binary.any():
        return None
    core = cv2.erode(binary, np.ones((3, 3), np.uint8))
    if not core.any():
        core = binary
    ring = cv2.dilate(binary, np.ones((5, 5), np.uint8)) - cv2.dilate(
        binary, np.ones((2, 2), np.uint8)
    )
    fg = np.median(rgb[core.astype(bool)], axis=0)
    if ring.any():
        bg = np.median(rgb[ring.astype(bool)], axis=0)
    else:
        bg = np.median(rgb.reshape(-1, 3), axis=0)
    return fg.astype(np.float32), bg.astype(np.float32)


def estimate_style(
    page: Image.Image,
    box: Box,
    kind: str,
    line_count: int,
    mask_roi: np.ndarray | None = None,
) -> Style:
    """Estimate text style from the ORIGINAL (not inpainted) page.

    With `mask_roi` (text pixels in page coordinates), the glyph colour comes from
    the mask rather than k-means over the whole crop, so a bubble's fill or outline
    does not dilute the text colour. K-means remains the fallback for no mask.
    """
    x0, y0 = max(box.x, 0), max(box.y, 0)
    x1, y1 = min(box.x + box.w, page.width), min(box.y + box.h, page.height)
    crop = page.crop((x0, y0, max(x1, x0 + 1), max(y1, y0 + 1)))
    colors = None
    if mask_roi is not None:
        roi = mask_roi[y0 : y0 + crop.height, x0 : x0 + crop.width]
        if roi.shape == (crop.height, crop.width):
            colors = _mask_colors(np.asarray(crop.convert("RGB"), np.float32), roi)
    fg, bg = colors if colors is not None else _two_colors(crop)
    fg, bg = _snap(fg), _snap(bg)

    # Light glyphs on a light bubble are unreadable, so such a sample is error,
    # not intent; white-on-dark SFX is a different branch and stays untouched.
    if kind == "text_bubble" and _luma(bg) >= 0.5 and _luma(fg) >= 0.75:
        fg = np.zeros(3)

    dark_bg = _luma(bg) < DARK_LUMA
    if kind == "text_free" or dark_bg:
        stroke_width = 3
        stroke = np.zeros(3) if _luma(fg) >= 0.5 else np.full(3, 255.0)
    else:
        stroke_width = 0
        stroke = np.full(3, 255.0)

    font_px = int(min(max(box.h / max(line_count, 1) * 0.8, 12), 72))

    bg_white = bool(np.all(bg == 255.0))
    if kind == "text_bubble" and not bg_white:
        # v1: rectangle-shape check skipped; non-white bubble → narration box.
        font = "narration"
    elif kind == "text_free" and box.h > 0.08 * page.height:
        font = "shout"
    else:
        font = "dialogue"

    return Style(
        color=_hex(fg),
        stroke_color=_hex(stroke),
        stroke_width=stroke_width,
        font_px=font_px,
        font=font,
    )
