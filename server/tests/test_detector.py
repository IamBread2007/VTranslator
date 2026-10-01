from pathlib import Path

import pytest
from PIL import Image

from mt.detector import ComicDetector

pytestmark = pytest.mark.slow

FIXTURE = Path(__file__).parent / "fixtures" / "page_ja.jpg"


def test_detects_text_bubble():
    img = Image.open(FIXTURE)
    found = ComicDetector().detect(img)
    labels = [lbl for _, lbl, _ in found]
    assert "text_bubble" in labels, labels
