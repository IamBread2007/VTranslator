from .schemas import Box


def tile_ranges(width: int, height: int) -> list[tuple[int, int]]:
    """Vertical tiles with 200px overlap; single tile when height <= 2*width."""
    if width <= 0 or height <= 0:
        return [(0, max(height, 0))]
    if height <= 2 * width:
        return [(0, height)]
    tile_h = int(1.5 * width)
    overlap = 200
    if tile_h <= overlap:
        return [(0, height)]
    step = tile_h - overlap
    ranges: list[tuple[int, int]] = []
    y0 = 0
    while y0 + tile_h < height:
        ranges.append((y0, y0 + tile_h))
        y0 += step
    ranges.append((y0, height))
    return ranges


def _iou(a: Box, b: Box) -> float:
    ix0, iy0 = max(a.x, b.x), max(a.y, b.y)
    ix1, iy1 = min(a.x + a.w, b.x + b.w), min(a.y + a.h, b.y + b.h)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    union = a.w * a.h + b.w * b.h - inter
    return inter / union if union else 0.0


def merge_boxes(found: list[tuple[Box, int, float]], iou_thr: float = 0.5) -> list[tuple[Box, int, float]]:
    """Per-class NMS: keep higher score, drop same-class boxes with IoU > thr."""
    kept: list[tuple[Box, int, float]] = []
    for box, label, score in sorted(found, key=lambda t: -t[2]):
        if any(lbl == label and _iou(box, kbox) > iou_thr for kbox, lbl, _ in kept):
            continue
        kept.append((box, label, score))
    return kept


def contains(outer: Box, inner: Box, min_frac: float = 0.8) -> bool:
    """True when at least min_frac of inner's area lies inside outer."""
    ix0, iy0 = max(outer.x, inner.x), max(outer.y, inner.y)
    ix1, iy1 = min(outer.x + outer.w, inner.x + inner.w), min(outer.y + outer.h, inner.y + inner.h)
    inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
    area = inner.w * inner.h
    return area > 0 and inter / area >= min_frac


def sort_reading_order(boxes: list[Box], rtl: bool = False) -> list[int]:
    """Group into rows (y tolerance = 0.5 x median height); sort x within row."""
    if not boxes:
        return []
    heights = sorted(b.h for b in boxes)
    med = heights[len(heights) // 2]
    tol = 0.5 * med if med > 0 else 0
    rows: list[list[int]] = []
    for i in sorted(range(len(boxes)), key=lambda i: (boxes[i].y, boxes[i].x)):
        if rows and boxes[i].y - boxes[rows[-1][0]].y <= tol:
            rows[-1].append(i)
        else:
            rows.append([i])
    out: list[int] = []
    for row in rows:
        row.sort(key=lambda i: boxes[i].x, reverse=rtl)
        out.extend(row)
    return out
