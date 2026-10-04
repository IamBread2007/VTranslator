import unicodedata
from pathlib import Path

import pytest
from PIL import Image

from mt.detector import ComicDetector
from mt.ocr import (
    choose_engine,
    crop_with_padding,
    get_engine,
    make_probe,
    resolve_source_lang,
    select_probe_crops,
)

pytestmark = pytest.mark.slow

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def detector():
    return ComicDetector()


@pytest.mark.parametrize(
    ("name", "lang", "evidence"),
    [
        ("page_ja.jpg", "ja", "high"),
        # PP-OCRv5 has only 2 Hangul chars → must go through korean probe.
        ("page_ko.jpg", "ko", "medium"),
        ("page_en.jpg", "en", "high"),
    ],
)
def test_resolves_page_language(detector, name, lang, evidence):
    img = Image.open(FIXTURES / name).convert("RGB")
    boxes = [b for b, kind, _ in detector.detect(img) if kind != "bubble"]
    assert boxes, f"no text boxes detected in {name}"
    crops = [crop_with_padding(img, b) for b in select_probe_crops(boxes, img.height)]
    r = resolve_source_lang(
        crops,
        requested="auto",
        primary=make_probe("paddle:v5"),
        korean=make_probe("paddle:korean"),
    )
    assert (r.lang, r.evidence) == (lang, evidence), r


def test_latin_engine_reads_portuguese_accents_intact(detector):
    """The reason pt exists as a manual choice.

    Both engines read Latin script, so auto cannot separate pt from en; the
    value of choosing pt is the latin recogniser, which keeps the accents the
    chinese-dict probe mangles ("bcè nao pode ser sérid" on this same fixture).
    """
    img = Image.open(FIXTURES / "page_pt.jpg").convert("RGB")
    boxes = [b for b, kind, _ in detector.detect(img) if kind != "bubble"]
    assert boxes, "no text boxes detected in page_pt.jpg"

    engine = get_engine(choose_engine("auto", "pt"))
    text = " ".join(engine.read(crop_with_padding(img, b)).text for b in boxes)

    folded = unicodedata.normalize("NFD", text)
    accented = [c for c in folded if unicodedata.combining(c)]
    assert accented, f"latin engine dropped every accent: {text!r}"
