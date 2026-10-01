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
