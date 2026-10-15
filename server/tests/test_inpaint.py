import numpy as np
from PIL import Image, ImageDraw

from mt.inpaint import OpenCvInpainter, text_mask
from mt.schemas import Box


def _page():
    img = Image.new("RGB", (200, 100), (255, 255, 255))
    ImageDraw.Draw(img).text((50, 40), "TEXT TEXT", fill=(0, 0, 0))
    return img


def test_mask_covers_text_only_inside_box():
    m = text_mask(_page(), [Box(x=40, y=30, w=120, h=40)])
    assert m.shape == (100, 200) and m[45, 60] in (0, 255)
    assert m[:, :35].sum() == 0 and m.sum() > 0


def test_inpaint_removes_dark_pixels():
    page = _page()
    out = OpenCvInpainter().inpaint(
        page, [(Box(x=40, y=30, w=120, h=40), "text_bubble")]
    )
    assert np.asarray(out)[30:70, 40:160].min() > 200


def _page_with_black_border():
    # A dark bubble outline runs along the ROI's top edge; the glyph sits inside.
    img = Image.new("RGB", (200, 100), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw.rectangle((30, 28, 170, 31), fill=(0, 0, 0))
    draw.text((60, 45), "A", fill=(0, 0, 0))
    return img


def test_border_stroke_touching_roi_edge_is_excluded():
    box = Box(x=30, y=28, w=140, h=50)
    m = text_mask(_page_with_black_border(), [box])
    assert m[28:32, 30:170].sum() == 0
    assert m.sum() > 0


def test_thin_glyph_mask_is_not_empty_and_has_text_pixels():
    # 1px strokes vanish under erode; the mask itself must still mark them.
    img = Image.new("RGB", (120, 60), (255, 255, 255))
    ImageDraw.Draw(img).line((20, 10, 20, 50), fill=(0, 0, 0), width=1)
    m = text_mask(img, [Box(x=5, y=5, w=100, h=50)])
    assert m.sum() > 0


def _dense_text_page():
    # Bold text in a tight box: three rows of glyph bars covering 64% of the
    # page, with a thin bright margin left at the box border.
    img = Image.new("RGB", (120, 60), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    strokes = np.zeros((60, 120), dtype=bool)
    for y in (3, 22, 41):
        for x in (3, 22, 41, 60, 79, 98):
            draw.rectangle((x, y, x + 15, y + 15), fill=(0, 0, 0))
            strokes[y : y + 16, x : x + 16] = True
    return img, strokes


def test_dense_text_mask_marks_strokes_not_background():
    # Over half the box is ink, so a minority vote flips the mask onto the
    # bubble ground: the glyphs are neither erased nor sampled.
    img, strokes = _dense_text_page()
    m = text_mask(img, [Box(x=0, y=0, w=120, h=60)])
    white = m > 0
    assert white.any(), "dense text produced an empty mask"
    overlap = np.count_nonzero(white & strokes) / np.count_nonzero(white)
    assert overlap > 0.5, f"mask marks background instead of strokes: {overlap:.2f}"
