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
