from itertools import pairwise

from mt.geometry import contains, merge_boxes, sort_reading_order, tile_ranges
from mt.schemas import Box


def test_tile_ranges_short_image_single_tile():
    assert tile_ranges(width=800, height=1200) == [(0, 1200)]


def test_tile_ranges_webtoon_overlaps_and_covers():
    r = tile_ranges(width=800, height=10000)  # tile_h = 1.5*w = 1200, overlap 200
    assert r[0] == (0, 1200) and r[-1][1] == 10000
    assert all(b[0] < a[1] for a, b in pairwise(r))  # chồng lấn


def test_merge_boxes_dedups_overlap_from_two_tiles():
    a = (Box(x=10, y=1100, w=100, h=80), 1, 0.9)
    b = (Box(x=12, y=1102, w=98, h=78), 1, 0.8)
    assert len(merge_boxes([a, b], iou_thr=0.5)) == 1


def test_contains():
    assert contains(Box(x=0, y=0, w=100, h=100), Box(x=10, y=10, w=20, h=20))
    assert not contains(Box(x=0, y=0, w=100, h=100), Box(x=80, y=80, w=100, h=100))


def test_reading_order_manga_right_to_left():
    boxes = [Box(x=0, y=0, w=10, h=10), Box(x=100, y=0, w=10, h=10)]
    assert sort_reading_order(boxes, rtl=True) == [1, 0]


def test_iomin_merges_split_bubble_halves_into_union():
    # Bubble straddling a tile seam: IoU ~0.31 (below thr) but the smaller
    # fragment lies ~83% inside the larger one, so IoMin >= 0.75 must merge
    # them into one union box.
    top = (Box(x=100, y=900, w=300, h=300), 1, 0.9)
    bottom = (Box(x=100, y=1100, w=300, h=120), 1, 0.7)
    merged = merge_boxes([top, bottom], iou_thr=0.5)
    assert len(merged) == 1
    box = merged[0][0]
    assert (box.x, box.y, box.w, box.h) == (100, 900, 300, 320)


def test_iomin_does_not_merge_adjacent_separate_bubbles():
    left = (Box(x=0, y=0, w=100, h=100), 1, 0.9)
    right = (Box(x=120, y=0, w=100, h=100), 1, 0.9)
    assert len(merge_boxes([left, right], iou_thr=0.5)) == 2


def test_iomin_does_not_merge_across_labels():
    a = (Box(x=0, y=0, w=100, h=100), 1, 0.9)
    b = (Box(x=0, y=0, w=100, h=100), 2, 0.9)
    assert len(merge_boxes([a, b], iou_thr=0.5)) == 2


def test_stitch_seam_joins_fragments_across_overlap_band():
    from mt.geometry import stitch_tile_seams

    # Tile A ends at y=1200, tile B starts at y=1000 -> band [1000, 1200].
    # Fragment halves are separated by 6px vertically and share the same x-span.
    upper = (Box(x=50, y=1100, w=200, h=90), 1, 0.8)  # bottom edge 1190
    lower = (Box(x=50, y=1196, w=200, h=80), 1, 0.8)  # top edge 1196, gap 6
    out = stitch_tile_seams([upper, lower], seams=[(1000, 1200)])
    assert len(out) == 1
    box = out[0][0]
    assert (box.y, box.h) == (1100, 176)


def test_stitch_seam_keeps_fragments_farther_than_gap():
    from mt.geometry import stitch_tile_seams

    upper = (Box(x=50, y=1100, w=200, h=50), 1, 0.8)  # bottom 1150
    lower = (Box(x=50, y=1180, w=200, h=50), 1, 0.8)  # top 1180, gap 30 > 12
    assert len(stitch_tile_seams([upper, lower], seams=[(1000, 1200)])) == 2


def test_stitch_seam_ignores_pairs_outside_band():
    from mt.geometry import stitch_tile_seams

    a = (Box(x=50, y=100, w=200, h=40), 1, 0.8)
    b = (Box(x=50, y=146, w=200, h=40), 1, 0.8)
    assert len(stitch_tile_seams([a, b], seams=[(1000, 1200)])) == 2
