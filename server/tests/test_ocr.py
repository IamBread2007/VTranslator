from PIL import Image

from mt.ocr import (
    choose_engine,
    classify_scripts,
    crop_with_padding,
    is_junk,
    pad_for_crop,
    padded_crop,
    resolve_from_probe,
    resolve_source_lang,
    select_probe_crops,
    split_han_only,
)
from mt.schemas import Box


def test_crop_clamps_to_image():
    img = Image.new("RGB", (100, 100))
    c = crop_with_padding(img, Box(x=95, y=95, w=10, h=10), pad=4)
    assert c.size == (9, 9)


def test_choose_engine_mapping():
    assert choose_engine("auto", "ja") == "manga_ocr"
    assert choose_engine("auto", "ko") == "paddle:korean"
    assert choose_engine("auto", "zh") == "paddle:v5"
    assert choose_engine("auto", "en") == "paddle:v5"
    assert choose_engine("paddle", "ja") == "paddle:v5"
    assert choose_engine("paddle", "ko") == "paddle:korean"


def test_choose_engine_sends_brazilian_portuguese_to_the_latin_model():
    # The chinese-dict probe misreads pt accents (measured: "Vocè nǎo", "Amanhǎ"),
    # while latin_PP-OCRv5_mobile_rec reads them exactly, so pt must never fall
    # through to the default paddle:v5 arm.
    assert choose_engine("auto", "pt") == "paddle:latin"
    assert choose_engine("paddle", "pt") == "paddle:latin"


def test_choose_engine_sends_every_latin_language_to_one_shared_engine():
    # es (which is what a "Mexican" source means: PaddleOCR has no mx code) and
    # id resolve to the same latin_PP-OCRv5_mobile_rec as pt. Measured on one
    # mixed es/id image: identical 0.987 confidence and correct accents for all
    # three codes, so a single engine key is right and three would load three
    # copies of one model.
    for lang in ("es", "id"):
        assert choose_engine("auto", lang) == "paddle:latin", lang
        assert choose_engine("paddle", lang) == "paddle:latin", lang


def test_classify_scripts_counts():
    ev = classify_scripts("안녕하세요 hello!")
    assert ev["hangul"] == 5 and ev["latin"] == 5 and ev["kana"] == 0


def test_resolve_kana_fast_path_high():
    assert resolve_from_probe("これはテストです。わろす", probe_confidence=0.9) == (
        "ja",
        "high",
    )


def test_resolve_latin_fast_path_high():
    text = "I don't know what you mean, okay?"
    assert resolve_from_probe(text, probe_confidence=0.9) == ("en", "high")


def test_resolve_hangul_fast_path_high():
    assert resolve_from_probe("오늘도 화이팅합니다", probe_confidence=0.9) == (
        "ko",
        "high",
    )


def test_resolve_han_only_is_ambiguous():
    assert resolve_from_probe("这是一个测试", probe_confidence=0.9) == (
        None,
        "ambiguous",
    )


def test_resolve_junk_probe_is_ambiguous():
    # junk-yield thấp → không tin script classification
    assert resolve_from_probe("안", probe_confidence=0.2) == (None, "ambiguous")


def test_split_han_only_finds_simplified_chinese():
    assert split_han_only("我们说过这个问题") == ("zh", "medium")


def test_split_han_only_finds_japanese_shinjitai():
    assert split_han_only("駅前桜沢弁図") == ("ja", "medium")


def test_split_han_only_shared_kanji_is_ambiguous():
    # có kana → không dùng split
    assert split_han_only("学校の先生") == (None, "ambiguous")


def test_select_probe_crops_spans_page():
    boxes = [
        Box(x=0, y=0, w=10, h=10),
        Box(x=0, y=100, w=10, h=10),
        Box(x=0, y=200, w=10, h=10),
        Box(x=0, y=300, w=10, h=10),
    ]
    picks = select_probe_crops(boxes, page_h=400, k=3)
    assert len(picks) == 3
    assert picks[0].y == 0 and picks[-1].y == 300
    assert len({b.y for b in picks}) == 3


def test_resolve_explicit_language_skips_probes():
    def boom(_):
        raise AssertionError("probe must not run when language is explicit")

    r = resolve_source_lang([], requested="ko", primary=boom, korean=boom)
    assert r.lang == "ko" and r.evidence == "explicit" and r.warnings == []


def test_resolve_fast_path_skips_korean_probe():
    def boom(_):
        raise AssertionError("korean probe must not run on fast path")

    r = resolve_source_lang(
        [], requested="auto", primary=lambda _: ("これはテストです", 0.9), korean=boom
    )
    assert (r.lang, r.evidence, r.warnings) == ("ja", "high", [])


def test_resolve_ambiguous_falls_to_korean_probe():
    # primary đọc ra Han-only (PP-OCRv5 không có Hangul) → korean probe
    r = resolve_source_lang(
        [],
        requested="auto",
        primary=lambda _: ("学校先生", 0.9),
        korean=lambda _: ("안녕하세요", 0.9),
    )
    assert (r.lang, r.evidence) == ("ko", "medium") and r.warnings == []


def test_resolve_low_evidence_warns():
    # han-only, không phân được ja/zh, korean probe không thấy Hangul
    r = resolve_source_lang(
        [],
        requested="auto",
        primary=lambda _: ("学校先生", 0.9),
        korean=lambda _: ("nothing", 0.9),
    )
    assert (r.lang, r.evidence) == ("zh", "low")
    assert r.warnings and "inconclusive" in r.warnings[0]


def test_korean_probe_never_pins_model_names():
    # Pinning a model name makes PaddleOCR ignore `lang`, which silently
    # swaps the korean probe to the zh dict (regression caught 2026-10-01).
    from mt.ocr import PADDLE_ARGS, PADDLE_MODELS

    assert set(PADDLE_MODELS) <= set(PADDLE_ARGS)
    assert "paddle:korean" not in PADDLE_MODELS


def test_pad_for_crop_scales_with_box_with_floor_of_eight():
    assert pad_for_crop(Box(x=0, y=0, w=100, h=50)) == 8  # 0.08*50=4 -> floor 8
    assert pad_for_crop(Box(x=0, y=0, w=400, h=300)) == 24  # 0.08*300


def test_short_bubble_dialogue_is_kept():
    assert is_junk("え?", "text_bubble", 0.61) is False
    assert is_junk("あっ", "text_bubble", 0.9) is False
    assert is_junk("ああ", "text_bubble", 0.9) is False
    assert is_junk("네?", "text_bubble", 0.9) is False


def test_symbol_noise_is_rejected():
    assert is_junk("///", "text_bubble", 0.9) is True
    assert is_junk("111", "text_bubble", 0.9) is True
    assert is_junk("///", "text_free", 0.4) is True


def test_strict_filter_only_for_low_confidence_text_free():
    assert is_junk("え?", "text_free", 0.4) is True
    assert is_junk("えっと", "text_free", 0.4) is False


def test_padded_crop_replicates_edges_outside_page():
    img = Image.new("RGB", (100, 100), (10, 20, 30))
    c = padded_crop(img, Box(x=0, y=0, w=10, h=10))
    assert c.size == (10 + 8 + 8, 10 + 8 + 8)
    assert c.getpixel((0, 0)) == (10, 20, 30)


class _ScriptedEngine:
    """Returns a canned confidence per call so the invert retry can be observed."""

    def __init__(self, confidences):
        self.confidences = list(confidences)
        self.seen = []

    def read(self, crop):
        from mt.ocr import OcrResult

        self.seen.append(crop.copy())
        return OcrResult(text="x", confidence=self.confidences.pop(0))


def test_read_crop_retries_inverted_when_low_confidence_on_dark_bubble():
    from mt.ocr import read_crop

    page = Image.new("RGB", (60, 60), (20, 20, 20))
    eng = _ScriptedEngine([0.3, 0.9])
    out = read_crop(eng, page, Box(x=10, y=10, w=30, h=30))
    assert out.confidence == 0.9
    assert len(eng.seen) == 2
    assert eng.seen[1].getpixel((0, 0)) == (255 - 20, 255 - 20, 255 - 20)


def test_read_crop_keeps_first_read_when_confident():
    from mt.ocr import read_crop

    page = Image.new("RGB", (60, 60), (20, 20, 20))
    eng = _ScriptedEngine([0.9])
    assert read_crop(eng, page, Box(x=10, y=10, w=30, h=30)).confidence == 0.9
    assert len(eng.seen) == 1


def test_read_crop_skips_invert_on_light_background():
    from mt.ocr import read_crop

    page = Image.new("RGB", (60, 60), (240, 240, 240))
    eng = _ScriptedEngine([0.3])
    read_crop(eng, page, Box(x=10, y=10, w=30, h=30))
    assert len(eng.seen) == 1
