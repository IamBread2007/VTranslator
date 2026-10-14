from PIL import Image, ImageDraw

from mt.schemas import Box
from mt.style import estimate_style


def _sample(fg, bg):
    img = Image.new("RGB", (120, 60), bg)
    ImageDraw.Draw(img).rectangle((20, 20, 100, 40), fill=fg)  # "nét chữ"
    return img


def test_black_text_on_white():
    s = estimate_style(
        _sample((0, 0, 0), (255, 255, 255)),
        Box(x=0, y=0, w=120, h=60),
        kind="text_bubble",
        line_count=1,
    )
    assert s.color == "#000000" and s.font == "dialogue"


def test_white_text_on_dark_gets_dark_stroke():
    s = estimate_style(
        _sample((255, 255, 255), (20, 20, 20)),
        Box(x=0, y=0, w=120, h=60),
        kind="text_free",
        line_count=1,
    )
    assert s.color == "#ffffff" and s.stroke_width > 0 and s.stroke_color == "#000000"


def _red_glyph_on_blue():
    # Red glyph on a blue bubble: k-means over the whole crop splits blue against
    # red and can settle on the blue, while the mask isolates the red fill.
    img = Image.new("RGB", (120, 60), (30, 60, 200))
    ImageDraw.Draw(img).rectangle((26, 24, 94, 36), fill=(220, 20, 20))
    return img


def test_red_glyph_on_blue_samples_the_glyph():
    from mt.inpaint import text_mask

    img = _red_glyph_on_blue()
    box = Box(x=0, y=0, w=120, h=60)
    mask = text_mask(img, [box])
    s = estimate_style(img, box, "text_bubble", 1, mask_roi=mask)
    r = int(s.color[1:3], 16)
    assert r > 150, s.color
    assert s.color.lower() != "#ffffff"


def test_thin_glyph_falls_back_to_nonempty_sample():
    import numpy as np

    img = Image.new("RGB", (120, 60), (255, 255, 255))
    ImageDraw.Draw(img).line((20, 10, 20, 50), fill=(0, 0, 0), width=1)
    box = Box(x=0, y=0, w=120, h=60)
    mask = np.zeros((60, 120), np.uint8)
    mask[10:51, 20] = 255
    s = estimate_style(img, box, "text_bubble", 1, mask_roi=mask)
    assert s.color.startswith("#") and len(s.color) == 7
