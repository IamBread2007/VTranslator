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
