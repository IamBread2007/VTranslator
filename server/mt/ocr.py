"""OCR engines + page-level source language resolution (script fast-path).

Language is decided from Unicode script evidence, never by comparing
rec_scores across different language models.
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol

import numpy as np
from PIL import Image

from .schemas import Box

Evidence = Literal["high", "medium", "low", "explicit"]
Probe = Callable[[list[Image.Image]], tuple[str, float | None]]

JUNK_THRESHOLD = 0.5
MIN_SCRIPT_CHARS = 3
MIN_SCRIPT_RATIO = 0.15
LATIN_RATIO = 0.8
MIN_LATIN_CHARS = 5
ZH_MIN_DISTINCT = 3
JA_MIN_DISTINCT = 2

# Simplified forms that differ from both traditional and Japanese shinjitai
# (diff simplified-vs-traditional, minus characters shared with shinjitai).
ZH_ONLY = frozenset(
    "们这说过个问题时为么还对吗吧呢给让认识话语请谁读听见觉观视车东长门开关间"
    "买卖农进远运边达层岁爱发书乐兴举龙马鸟鱼风飞无业专丽习乡亲仅从众优伤"
    "钱银铁错闻阳阴队难页顶项须顺领颜饭饮驾鸡鲜头样实战单转传变济经续绿隐总"
)
# Shinjitai that differ from both traditional and simplified Chinese
# (diff shinjitai-vs-traditional, minus characters shared with simplified).
JA_ONLY = frozenset(
    "駅桜沢弁図広仏払売読歩渋浜険験検剣圧囲営栄円縄恵拡価気楽薬鉄単戦観権歳様"
    "黒県帰転伝対発変実辺済斎斉経続緑隠庁総聴徳姫雑涙悪亜込畑峠辻働枠"
)


@dataclass(frozen=True)
class OcrResult:
    text: str
    confidence: float | None


class OcrEngine(Protocol):
    def read(self, crop: Image.Image) -> OcrResult: ...


@dataclass
class ResolveResult:
    lang: str
    evidence: Evidence
    warnings: list[str] = field(default_factory=list)


def crop_with_padding(img: Image.Image, box: Box, pad: int = 4) -> Image.Image:
    x0 = max(0, box.x - pad)
    y0 = max(0, box.y - pad)
    x1 = min(img.width, box.x + box.w + pad)
    y1 = min(img.height, box.y + box.h + pad)
    return img.crop((x0, y0, x1, y1))


def choose_engine(ocr_engine: str, lang: str) -> str:
    if ocr_engine == "auto":
        return {"ja": "manga_ocr", "ko": "paddle:korean"}.get(lang, "paddle:v5")
    if ocr_engine == "paddle":
        return "paddle:korean" if lang == "ko" else "paddle:v5"
    raise ValueError(f"unknown ocr_engine: {ocr_engine}")


# ---------- pure script fast-path ----------


def _script_of(ch: str) -> str | None:
    o = ord(ch)
    if 0xAC00 <= o <= 0xD7A3:
        return "hangul"
    if 0x3040 <= o <= 0x30FF or 0xFF66 <= o <= 0xFF9F:
        return "kana"
    if 0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF:
        return "han"
    if ("A" <= ch <= "Z") or ("a" <= ch <= "z") or 0x00C0 <= o <= 0x024F:
        return "latin"
    return None


def classify_scripts(text: str) -> dict[str, int]:
    """Count chars per script; `alphabetic` excludes spaces, digits, punctuation."""
    ev = {"hangul": 0, "kana": 0, "han": 0, "latin": 0, "alphabetic": 0}
    for ch in text:
        script = _script_of(ch)
        if script is not None:
            ev[script] += 1
            ev["alphabetic"] += 1
        elif ch.isalpha():
            ev["alphabetic"] += 1
    return ev


def _has_script(ev: dict[str, int], script: str) -> bool:
    n = ev[script]
    return n >= MIN_SCRIPT_CHARS and n >= MIN_SCRIPT_RATIO * ev["alphabetic"]


def resolve_from_probe(
    text: str, probe_confidence: float | None
) -> tuple[str | None, Literal["high", "ambiguous"]]:
    if probe_confidence is not None and probe_confidence < JUNK_THRESHOLD:
        return None, "ambiguous"
    ev = classify_scripts(text)
    if _has_script(ev, "kana"):
        return "ja", "high"
    if _has_script(ev, "hangul"):
        return "ko", "high"
    if ev["latin"] >= MIN_LATIN_CHARS and ev["latin"] >= LATIN_RATIO * ev["alphabetic"]:
        return "en", "high"
    return None, "ambiguous"


def split_han_only(text: str) -> tuple[str | None, Literal["medium", "ambiguous"]]:
    ev = classify_scripts(text)
    if ev["kana"] or ev["hangul"] or not ev["han"]:
        return None, "ambiguous"
    chars = set(text)
    if len(chars & ZH_ONLY) >= ZH_MIN_DISTINCT:
        return "zh", "medium"
    if len(chars & JA_ONLY) >= JA_MIN_DISTINCT:
        return "ja", "medium"
    return None, "ambiguous"


# ---------- orchestration ----------


def select_probe_crops(text_boxes: Sequence[Box], page_h: int, k: int = 3) -> list[Box]:
    """Largest box per vertical band (top/middle/bottom), topped up by area."""
    if not text_boxes or k <= 0:
        return []
    by_area = sorted(text_boxes, key=lambda b: b.w * b.h, reverse=True)
    band_h = max(1, page_h) / k
    picks: list[Box] = []
    for band in range(k):
        for b in by_area:
            center = b.y + b.h / 2
            if min(int(center // band_h), k - 1) == band:
                picks.append(b)
                break
    for b in by_area:
        if len(picks) >= k:
            break
        if b not in picks:
            picks.append(b)
    return sorted(picks[:k], key=lambda b: b.y)


def _fallback_lang(texts: Sequence[str]) -> str:
    ev = classify_scripts("".join(texts))
    counts = {"ja": ev["kana"], "ko": ev["hangul"], "en": ev["latin"], "zh": ev["han"]}
    best = max(counts, key=lambda lang: counts[lang])
    # Nothing readable at all: default to manga's most common source.
    return best if counts[best] else "ja"


def resolve_source_lang(
    crops: list[Image.Image], requested: str, primary: Probe, korean: Probe
) -> ResolveResult:
    if requested != "auto":
        return ResolveResult(requested, "explicit", [])

    text, conf = primary(crops)
    lang, _ = resolve_from_probe(text, conf)
    if lang:
        return ResolveResult(lang, "high", [])

    lang, _ = split_han_only(text)
    if lang:
        return ResolveResult(lang, "medium", [])

    ko_text, _ = korean(crops)
    if _has_script(classify_scripts(ko_text), "hangul"):
        return ResolveResult("ko", "medium", [])

    ev = classify_scripts(text)
    han_only = ev["han"] > 0 and ev["han"] == ev["alphabetic"]
    lang = "zh" if han_only else _fallback_lang([text, ko_text])
    warning = (
        f"source language auto-detection inconclusive (evidence=low); using {lang}"
    )
    return ResolveResult(lang, "low", [warning])


# ---------- engines (lazy, cached by key) ----------

PADDLE_ARGS = {
    "paddle:v5": {"lang": "ch"},
    "paddle:korean": {"lang": "korean"},
}

# Server models cost 4-15s per vertical bubble crop on CPU (measured 2026-10-01);
# mobile does the whole page in ~6s and a crop in ~0.4s. Pinning any model name
# makes PaddleOCR ignore `lang`, so only the zh-dict primary probe may pin models;
# `lang="korean"` already resolves to a mobile rec with the Hangul dict.
PADDLE_MODELS = {
    "paddle:v5": {
        "text_detection_model_name": "PP-OCRv5_mobile_det",
        "text_recognition_model_name": "PP-OCRv5_mobile_rec",
    },
}


class PaddleOcrEngine:
    def __init__(self, key: str):
        from paddleocr import PaddleOCR

        if key not in PADDLE_ARGS:
            raise ValueError(f"unknown paddle engine: {key}")
        self.key = key
        self._ocr = PaddleOCR(
            **PADDLE_ARGS[key],
            ocr_version="PP-OCRv5",
            **PADDLE_MODELS.get(key, {}),
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            # Paddle 3.3 oneDNN/PIR bug: ConvertPirAttribute2RuntimeAttribute.
            enable_mkldnn=False,
        )

    def read(self, crop: Image.Image) -> OcrResult:
        res = self._ocr.predict(np.asarray(crop.convert("RGB")))
        texts: list[str] = []
        scores: list[float] = []
        for page in res:
            for t, s in zip(page["rec_texts"], page["rec_scores"], strict=True):
                if t.strip():
                    texts.append(t)
                    scores.append(float(s))
        conf = sum(scores) / len(scores) if scores else 0.0
        return OcrResult("".join(texts), conf)


class MangaOcrEngine:
    def __init__(self):
        from manga_ocr import MangaOcr

        self._mocr = MangaOcr()

    def read(self, crop: Image.Image) -> OcrResult:
        return OcrResult(self._mocr(crop.convert("RGB")), None)


_ENGINES: dict[str, OcrEngine] = {}


def get_engine(key: str) -> OcrEngine:
    if key not in _ENGINES:
        _ENGINES[key] = MangaOcrEngine() if key == "manga_ocr" else PaddleOcrEngine(key)
    return _ENGINES[key]


def make_probe(key: str, get: Callable[[str], OcrEngine] | None = None) -> Probe:
    """Probe callable over crops; engine is loaded only when first called."""
    getter = get or get_engine

    def probe(crops: list[Image.Image]) -> tuple[str, float | None]:
        engine = getter(key)
        results = [engine.read(c) for c in crops]
        scored = [r.confidence for r in results if r.text and r.confidence is not None]
        conf = sum(scored) / len(scored) if scored else 0.0
        return "\n".join(r.text for r in results if r.text), conf

    return probe
