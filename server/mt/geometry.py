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


def _iomin(a: Box, b: Box) -> float:
    """Intersection over the smaller box: high when one fragment sits inside the other."""
    ix0, iy0 = max(a.x, b.x), max(a.y, b.y)
    ix1, iy1 = min(a.x + a.w, b.x + b.w), min(a.y + a.h, b.y + b.h)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    smaller = min(a.w * a.h, b.w * b.h)
    return inter / smaller if smaller else 0.0


def _union(a: Box, b: Box) -> Box:
    x0, y0 = min(a.x, b.x), min(a.y, b.y)
    x1, y1 = max(a.x + a.w, b.x + b.w), max(a.y + a.h, b.y + b.h)
    return Box(x=x0, y=y0, w=x1 - x0, h=y1 - y0)


# A bubble cut by a tile seam yields two fragments whose IoU is low (each covers
# only part of the bubble), but the smaller fragment lies almost fully inside
# the union. IoMin catches that case; plain IoU would leave two overlapping
# translations for one bubble.
IOMIN_THR = 0.75


def merge_boxes(
    found: list[tuple[Box, int, float]], iou_thr: float = 0.5
) -> list[tuple[Box, int, float]]:
    """Per-class merge: same-class boxes that overlap (IoU > thr or IoMin >= 0.75)
    collapse into their union, keeping the highest score."""
    kept: list[tuple[Box, int, float]] = []
    for box, label, score in sorted(found, key=lambda t: -t[2]):
        for i, (kbox, lbl, ksc) in enumerate(kept):
            if lbl == label and (
                _iou(box, kbox) > iou_thr or _iomin(box, kbox) >= IOMIN_THR
            ):
                kept[i] = (_union(kbox, box), lbl, ksc)
                break
        else:
            kept.append((box, label, score))
    return kept


# Fragments split by a seam are separated by a thin horizontal gap inside the
# overlap band; a real neighbouring bubble sits farther apart than this.
SEAM_MAX_GAP = 12
SEAM_MIN_H_OVERLAP = 0.6


def stitch_tile_seams(
    found: list[tuple[Box, int, float]],
    seams: list[tuple[int, int]],
    max_gap: int = SEAM_MAX_GAP,
    min_h_overlap: float = SEAM_MIN_H_OVERLAP,
) -> list[tuple[Box, int, float]]:
    """Join same-class fragments that are stacked across a tile overlap band.

    Two fragments join when the vertical gap between them is at most `max_gap`,
    lies inside a seam band, and their x-extents overlap by at least
    `min_h_overlap` of the narrower box.
    """
    items = list(found)
    merged = True
    while merged:
        merged = False
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                a, la, sa = items[i]
                b, lb, sb = items[j]
                if la != lb or not _seam_pair(a, b, seams, max_gap, min_h_overlap):
                    continue
                items[i] = (_union(a, b), la, max(sa, sb))
                del items[j]
                merged = True
                break
            if merged:
                break
    return items


def _seam_pair(
    a: Box,
    b: Box,
    seams: list[tuple[int, int]],
    max_gap: int,
    min_h_overlap: float,
) -> bool:
    up, dn = (a, b) if a.y <= b.y else (b, a)
    gap_lo = up.y + up.h
    gap_hi = dn.y
    if gap_hi - gap_lo > max_gap:
        return False
    lo, hi = min(gap_lo, gap_hi), max(gap_lo, gap_hi)
    if not any(max(lo, s0) <= min(hi, s1) for s0, s1 in seams):
        return False
    x_overlap = min(a.x + a.w, b.x + b.w) - max(a.x, b.x)
    narrower = min(a.w, b.w)
    return narrower > 0 and x_overlap / narrower >= min_h_overlap


def contains(outer: Box, inner: Box, min_frac: float = 0.8) -> bool:
    """True when at least min_frac of inner's area lies inside outer."""
    ix0, iy0 = max(outer.x, inner.x), max(outer.y, inner.y)
    ix1, iy1 = (
        min(outer.x + outer.w, inner.x + inner.w),
        min(outer.y + outer.h, inner.y + inner.h),
    )
    inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
    area = inner.w * inner.h
    return area > 0 and inter / area >= min_frac


def _union_of(boxes: list[Box], idxs: list[int]) -> Box:
    x0 = min(boxes[i].x for i in idxs)
    y0 = min(boxes[i].y for i in idxs)
    x1 = max(boxes[i].x + boxes[i].w for i in idxs)
    y1 = max(boxes[i].y + boxes[i].h for i in idxs)
    return Box(x=x0, y=y0, w=x1 - x0, h=y1 - y0)


def _widest_gap(spans: list[tuple[float, float]]) -> tuple[float, float]:
    """Widest empty stretch between projected spans, as (size, cut position).

    Size is 0 when the spans cover the axis, so callers never handle an Optional.
    """
    ordered = sorted(spans)
    best = (0.0, 0.0)
    reach = ordered[0][1]
    for start, end in ordered[1:]:
        if start > reach:
            gap = start - reach
            if gap > best[0]:
                best = (gap, (reach + start) / 2)
        reach = max(reach, end)
    return best


def _units(
    boxes: list[Box], idxs: list[int], bubbles: tuple[Box, ...]
) -> list[list[int]]:
    """Reading units: each text box alone, except all text in one bubble is one unit.

    Keeping bubble text together stops a sentence split by a neighbouring bubble
    from being read as two unrelated lines.
    """
    owned: dict[int, list[int]] = {}
    units: list[list[int]] = []
    for i in idxs:
        owner = next(
            (k for k, bb in enumerate(bubbles) if contains(bb, boxes[i])), None
        )
        if owner is None:
            units.append([i])
        else:
            owned.setdefault(owner, []).append(i)
    units.extend(owned.values())
    return units


def _leaf_order(
    boxes: list[Box], idxs: list[int], rtl: bool, tol: float, bubbles: tuple[Box, ...]
) -> list[int]:
    """Read a cell that has no panel gutter: rows top to bottom, units left to right."""
    placed = sorted(
        ((_union_of(boxes, u), u) for u in _units(boxes, idxs, bubbles)),
        key=lambda t: (t[0].y, t[0].x),
    )
    rows: list[list[tuple[Box, list[int]]]] = []
    for item in placed:
        if rows and item[0].y - rows[-1][0][0].y <= tol:
            rows[-1].append(item)
        else:
            rows.append([item])
    out: list[int] = []
    for row in rows:
        row.sort(key=lambda t: t[0].x, reverse=rtl)
        for _, unit in row:
            out.extend(sorted(unit, key=lambda i: (boxes[i].y, boxes[i].x)))
    return out


def _xy_cut(
    boxes: list[Box],
    idxs: list[int],
    rtl: bool,
    min_x_gap: float,
    min_y_gap: float,
    bubbles: tuple[Box, ...],
) -> list[int]:
    if len(idxs) <= 1:
        return list(idxs)
    # The widest gap on each axis is a candidate cut. A vertical gutter separates
    # panel columns; a horizontal band separates tiers. The wider gap wins, so a
    # tall gutter is not overridden by a thin line gap.
    x_size, x_cut = _widest_gap([(boxes[i].x, boxes[i].x + boxes[i].w) for i in idxs])
    y_size, y_cut = _widest_gap([(boxes[i].y, boxes[i].y + boxes[i].h) for i in idxs])
    cut_x = x_size > 0 and x_size >= min_x_gap
    cut_y = y_size > 0 and y_size >= min_y_gap
    if cut_x and (not cut_y or x_size >= y_size):
        low = [i for i in idxs if boxes[i].x + boxes[i].w / 2 < x_cut]
        high = [i for i in idxs if boxes[i].x + boxes[i].w / 2 >= x_cut]
        first, second = (high, low) if rtl else (low, high)
        return _xy_cut(boxes, first, rtl, min_x_gap, min_y_gap, bubbles) + _xy_cut(
            boxes, second, rtl, min_x_gap, min_y_gap, bubbles
        )
    if cut_y:
        top = [i for i in idxs if boxes[i].y + boxes[i].h / 2 < y_cut]
        bottom = [i for i in idxs if boxes[i].y + boxes[i].h / 2 >= y_cut]
        return _xy_cut(boxes, top, rtl, min_x_gap, min_y_gap, bubbles) + _xy_cut(
            boxes, bottom, rtl, min_x_gap, min_y_gap, bubbles
        )
    # No qualifying gap: the cell is one tier. The half-median band threshold also
    # serves as the row tolerance, so line spacing and tier spacing agree.
    return _leaf_order(boxes, idxs, rtl, min_y_gap, bubbles)


def sort_reading_order(
    boxes: list[Box], rtl: bool = False, bubbles: tuple[Box, ...] = ()
) -> list[int]:
    """Panel-aware reading order via recursive XY-Cut.

    A gutter must reach 4% of the page width and a band half the median box
    height to split the page, so ordinary line spacing does not cut a panel. `rtl`
    reads the right column first. `bubbles` is optional: without it every text box
    is its own unit, and the result is pure geometry.
    """
    if not boxes:
        return []
    heights = sorted(b.h for b in boxes)
    med = heights[len(heights) // 2]
    tol = 0.5 * med if med > 0 else 0.0
    page_w = max(b.x + b.w for b in boxes) - min(b.x for b in boxes)
    return _xy_cut(boxes, list(range(len(boxes))), rtl, 0.04 * page_w, tol, bubbles)
