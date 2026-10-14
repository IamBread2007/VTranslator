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


def test_rtl_reads_right_panel_first():
    # Two panels: right column holds two stacked bubbles, left column holds one
    # bubble offset lower. Row grouping zigzags across the page; XY-Cut must
    # finish the right column top-to-bottom before moving left.
    right_top = Box(x=600, y=0, w=200, h=100)
    right_bottom = Box(x=600, y=300, w=200, h=100)
    left_mid = Box(x=50, y=150, w=200, h=100)
    order = sort_reading_order([right_top, right_bottom, left_mid], rtl=True)
    assert order == [0, 1, 2]


def test_ltr_reads_left_panel_first():
    left_top = Box(x=50, y=0, w=200, h=100)
    left_bottom = Box(x=50, y=300, w=200, h=100)
    right_mid = Box(x=600, y=150, w=200, h=100)
    order = sort_reading_order([left_top, left_bottom, right_mid], rtl=False)
    assert order == [0, 1, 2]


def test_same_bubble_text_stays_adjacent():
    # Two text boxes inside one bubble on the left, one bubble on the right.
    # The bubble contains both fragments, so they must stay together even
    # though the right bubble sits between them in y.
    bubble = Box(x=0, y=0, w=300, h=400)
    frag_a = Box(x=20, y=20, w=100, h=40)
    frag_b = Box(x=20, y=200, w=100, h=40)
    right = Box(x=400, y=100, w=200, h=100)
    order = sort_reading_order([frag_a, right, frag_b], rtl=True, bubbles=(bubble,))
    assert order.index(0) + 1 == order.index(2)


def test_no_valley_falls_back_to_rows():
    a = Box(x=0, y=0, w=50, h=40)
    b = Box(x=60, y=2, w=50, h=40)
    c = Box(x=0, y=100, w=50, h=40)
    assert sort_reading_order([c, b, a], rtl=False) == [2, 1, 0]
