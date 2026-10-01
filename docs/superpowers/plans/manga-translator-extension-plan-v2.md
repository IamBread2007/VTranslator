# Manga Translator Chrome Extension Implementation Plan — Revised v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extension Chrome dịch ảnh manga/manhwa/webtoon ngay trên trang đang đọc: phát hiện bubble → OCR → AI dịch có nhìn cả ảnh lẫn text → xoá chữ gốc → vẽ bản dịch tiếng Việt giữ màu/viền/cỡ chữ.

**Architecture:** Hai phần. (1) `server/`: Python FastAPI chạy local tại `127.0.0.1:8765`, làm phần nặng (detect RT-DETR-v2 của ogkalu, OCR PaddleOCR / manga-ocr, ước lượng style, inpaint OpenCV / LaMa, gọi LLM vision qua API OpenAI-compatible như OmniRoute). (2) `extension/`: Chrome MV3 nhẹ, chỉ tìm ảnh, gửi bytes lên server, nhận ảnh đã xoá chữ + metadata block, tự layout/vẽ chữ bằng canvas rồi thay ảnh trên trang. Model nặng không chạy trong trình duyệt.

**Điểm kiến trúc quan trọng của v2:**
- Webtoon dài **không** bị thu nhỏ toàn trang trước khi gửi LLM; một page vẫn là **một LLM request**, nhưng request có thể chứa overview + nhiều vertical tile để chữ/biểu cảm vẫn đọc được.
- Cache tách thành **perception cache** (detect/OCR/style/inpaint) và **translation cache** (LLM + context), để đổi model/prompt/context không phải chạy lại toàn bộ ML pipeline.
- Style luôn được ước lượng từ **ảnh gốc trước inpaint**.
- Auto-translate giữ thứ tự DOM và chỉ có **1 `/translate` đang chạy mỗi tab** để `prev_context` không bị race; mọi xử lý vẫn async nên không block UI.

**Tech Stack:** Python 3.11, FastAPI, uvicorn, pydantic v2, transformers + torch, paddleocr 3.x, manga-ocr, opencv-python, Pillow, numpy, httpx, pytest; TypeScript, esbuild, vitest, Chrome Manifest V3. ONNX detector là tối ưu hoá sau v1, không phải dependency bắt buộc ban đầu.

**Spec:** Chưa có spec riêng (bỏ qua bước brainstorming). Yêu cầu lấy từ hội thoại và được ghi trong Global Constraints. Tham khảo: `zyddnys/manga-image-translator` (pipeline 4 bước), `ogkalu/comic-text-and-bubble-detector`, `JeffersonQin/YuzuMarker.FontDetection`.

> Scope note: plan gồm 2 subsystem (server, extension) nhưng chia phase: hết Phase A đã có server dùng được qua `curl`; hết Phase B có extension end-to-end.

## Global Constraints

- Dùng cá nhân, chạy local. Server chỉ bind `127.0.0.1`, port mặc định `8765`.
- `GET /health` không cần auth để kiểm tra server sống. Mọi endpoint khác, bao gồm `GET /auth-check` và `POST /translate`, phải có header `X-MT-Token` khớp `MT_TOKEN`; sai → `401`.
- Ngôn ngữ đích mặc định `vi`; nguồn: `ja`, `ko`, `zh`, `en`; `auto` là best-effort và phải resolve **ở cấp page** trước khi OCR toàn bộ block.
- LLM: endpoint OpenAI-compatible `POST {LLM_BASE_URL}/chat/completions`, cấu hình bằng `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`; không hardcode provider; model phải hỗ trợ input ảnh.
- Mỗi page dùng **1 LLM request**. Manga/page thường gửi một annotated image; webtoon dài gửi **overview + nhiều annotated tile trong cùng request**. Không resize toàn webtoon thành một ảnh hẹp.
- AI luôn nhận cả visual context và danh sách `id: OCR text`; `prev_context` tối đa 20 dòng dịch trước đó.
- Không copy code từ `manga-image-translator` (GPL-3.0) trừ khi chấp nhận cả project thành GPL-3.0; chỉ tham khảo thiết kế. YuzuMarker là MIT.
- Font render phải có đủ dấu tiếng Việt: bundle `Patrick Hand` (thoại), `Bangers` (hét/SFX), `Be Vietnam Pro` (lời dẫn), xác minh subset `vietnamese`; bundle kèm license OFL.
- Pin version: sau khi cài, chốt version bằng `pip freeze > server/requirements.lock` và `package-lock.json`; không dùng range mở.
- Render tiếng Việt theo chiều ngang.
- Image limits phải kiểm tra **trước** `.convert("RGB")`: mặc định `MAX_IMAGE_BYTES=25MB`, `MAX_DIMENSION=20000`, `MAX_PIXELS=30000000`.
- Auto translate xử lý page theo thứ tự DOM: tối đa **1 request `/translate` đang chạy mỗi tab** để context trang trước luôn sẵn sàng. Có thể prefetch URL/bytes riêng, nhưng không được làm hai LLM translation song song trong cùng tab ở v1.
- Secret `token` của extension lưu ở `chrome.storage.local`; settings không nhạy cảm mới dùng `chrome.storage.sync`.
- Cache trên disk không lưu PNG dưới dạng base64; metadata JSON và binary `.png` phải tách file.
- File `.env` không commit (`.gitignore`).

## Review Focus

1. **Hotlink/auth ảnh:** site trả `403/401` khi fetch không có `Referer` → thêm temporary DNR rule, retry, xoá rule trong `finally`; lỗi cuối phải hiển thị rõ → Task 13.
2. **Webtoon dài ở detector:** cao > 3× rộng phải cắt vertical tile chồng lấn rồi NMS/gộp box, không resize cả ảnh → Task 3.
3. **Webtoon dài ở Vision LLM:** annotated full page chỉ dùng làm overview; LLM phải nhận thêm tile giữ độ phân giải chữ/nhân vật → Task 5.
4. **LLM JSON/error:** fenced JSON, JSON hỏng, thiếu id, 429, timeout → retry JSON đúng 1 lần; block thiếu dịch giữ source; lỗi mạng/API trả `502` có message → Task 5/8.
5. **Cache semantics:** context/model/prompt thay đổi phải invalidate translation cache nhưng không bắt buộc rerun detector/OCR/inpaint; `prev_context` phải nằm trong translation key → Task 8.
6. **Thứ tự pipeline:** style lấy từ ảnh gốc trước inpaint; LLM cũng nhìn ảnh gốc annotated, không nhìn ảnh đã xoá chữ → Task 8.
7. **Ảnh không có chữ:** trả `blocks: []`, không gọi LLM → Task 8.
8. **Decompression bomb/RAM:** kiểm tra file bytes, dimension, total pixels trước RGB decode → Task 8.
9. **`source_lang=auto`:** không dùng chiều cao block để đoán Japanese; resolve page-level bằng script fast-path (primary PP-OCRv5 → secondary chỉ khi ambiguous) với evidence `high/medium/low`, warning khi evidence low → Task 4.
10. **Lazy-load:** `data-src`, `srcset`, `currentSrc`, src đổi sau scroll; không dịch lại blob do extension tạo → Task 12.
11. **Context ordering:** page N+1 không được gửi `/translate` trước khi page N cập nhật `prev_context` → Task 12.
12. **Token UX:** `/health` chỉ chứng minh server sống; Options phải gọi thêm `/auth-check` để xác nhận token thật sự đúng → Task 1/9.

---

## File Structure

```text
server/
  pyproject.toml
  requirements.txt
  .env.example
  mt/
    __init__.py
    config.py               # Settings + image limits
    app.py                  # /health, /auth-check, /translate
    schemas.py              # Box, Block, Style, TranslateResponse, TranslateOptions
    geometry.py             # tile_ranges, merge_boxes, contains, sort_reading_order
    detector.py             # ComicDetector (ogkalu RT-DETR-v2)
    ocr.py                  # OCR engines + page-level source language probe
    translator.py           # annotate/vision tiles/messages/parse/LlmTranslator
    style.py                # estimate_style, YuzuStyleEstimator optional
    inpaint.py              # text mask, OpenCV/LaMa
    pipeline.py             # orchestration; style before inpaint
    cache.py                # StageCache: perception JSON+PNG, translation JSON
    __main__.py
  tests/
    fixtures/
    test_app.py test_geometry.py test_detector.py test_ocr.py
    test_translator.py test_style.py test_inpaint.py test_pipeline.py test_cache.py
extension/
  package.json tsconfig.json build.mjs
  manifest.json
  fonts/
  src/
    types.ts
    settings.ts             # sync public settings; local token
    layout.ts
    render.ts
    background.ts           # fetch image, hotlink retry, server call
    referer.ts
    content.ts              # discovery UI + per-tab sequential queue/context
    discover.ts
    options.html options.ts
  tests/
    layout.test.ts discover.test.ts referer.test.ts settings.test.ts
```

Hợp đồng API giữa 2 phần (nguồn sự thật: `server/mt/schemas.py`, `extension/src/types.ts` phải khớp):

```text
GET /health
200 -> {"ok": true}

GET /auth-check
X-MT-Token: ...
200 -> {"ok": true}
401 -> {"detail":"invalid token"}

POST /translate  (multipart: image=<file>, options=<json string>)
X-MT-Token: ...
options = {"source_lang": "auto|ja|ko|zh|en", "target_lang": "vi", "prev_context": ["..."]}
200 -> {
  "width": int, "height": int,
  "inpainted_png": "<base64>",
  "resolved_source_lang": "ja|ko|zh|en",
  "blocks": [{
    "id": int, "box": {"x":int,"y":int,"w":int,"h":int},
    "render_box": {"x":..,"y":..,"w":..,"h":..},
    "kind": "text_bubble|text_free",
    "source": str, "translation": str,
    "style": {"color":"#rrggbb","stroke_color":"#rrggbb","stroke_width":int,
              "font_px":int,"font":"dialogue|shout|narration"}
  }],
  "warnings": [str]
}
```

> `inpainted_png` vẫn dùng base64 trong API v1 để extension đơn giản. Chỉ **disk cache** phải lưu PNG binary riêng để tránh overhead base64 ~33%.

---

## Phase A — Server

### Task 1: Scaffold server, config, auth, `/health`, `/auth-check`

**Files:**
- Create: `server/pyproject.toml`, `server/requirements.txt`, `server/.env.example`, `server/mt/__init__.py`, `server/mt/config.py`, `server/mt/app.py`, `.gitignore`
- Test: `server/tests/test_app.py`

- [ ] **Step 1: `git init` ở root, tạo `.gitignore`** gồm `server/.env`, `server/.cache/`, `__pycache__/`, `.venv/`, `node_modules/`, `extension/dist/`.
- [ ] **Step 2: Tạo venv và cài deps**

`server/requirements.txt`:
```text
fastapi
uvicorn[standard]
pydantic-settings
python-multipart
httpx
numpy
pillow
opencv-python-headless
torch
transformers
paddlepaddle
paddleocr
manga-ocr
pytest
```
Run: `cd server && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt && .venv/Scripts/pip freeze > requirements.lock`

- [ ] **Step 3: Viết test fail**

```python
# server/tests/test_app.py
from fastapi.testclient import TestClient
from mt.app import create_app
from mt.config import Settings

def make_client():
    s = Settings(mt_token="secret", llm_base_url="http://x", llm_api_key="k", llm_model="m")
    return TestClient(create_app(s, pipeline=None))

def test_health_no_auth():
    assert make_client().get("/health").json() == {"ok": True}

def test_auth_check_requires_token():
    c = make_client()
    assert c.get("/auth-check").status_code == 401
    assert c.get("/auth-check", headers={"X-MT-Token":"secret"}).json() == {"ok": True}

def test_translate_requires_token():
    r = make_client().post("/translate", files={"image": ("a.png", b"x")})
    assert r.status_code == 401
```

- [ ] **Step 4:** Run `cd server && .venv/Scripts/pytest tests/test_app.py -v` → FAIL.
- [ ] **Step 5: Implement config**

```python
# server/mt/config.py
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env")
    mt_token: str
    llm_base_url: str
    llm_api_key: str
    llm_model: str
    ocr_engine: str = "auto"          # auto | paddle | manga_ocr
    inpainter: str = "opencv"         # opencv | lama
    style_engine: str = "kmeans"      # kmeans | yuzu
    cache_dir: str = ".cache"
    llm_timeout_s: float = 90.0
    host: str = "127.0.0.1"
    port: int = 8765
    max_image_bytes: int = 25 * 1024 * 1024
    max_dimension: int = 20_000
    max_pixels: int = 30_000_000
```

- [ ] **Step 6: Implement app skeleton** với `hmac.compare_digest`; CORS chỉ cho `chrome-extension://...`; `/health` public; `/auth-check` có `Depends(auth)`; `/translate` hiện trả `501` nhưng cũng có auth.
- [ ] **Step 7:** `.env.example` có `MT_TOKEN`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `OCR_ENGINE`, `INPAINTER`, `STYLE_ENGINE`.
- [ ] **Step 8:** pytest → PASS. **Commit** `server: scaffold, config, token auth`.

### Task 2: Schemas

**Files:** Create `server/mt/schemas.py`; Test `server/tests/test_app.py` (thêm)

- [ ] **Step 1: Test fail**

```python
def test_schema_roundtrip():
    from mt.schemas import Block, Box, Style, TranslateResponse
    b = Block(id=1, box=Box(x=0, y=0, w=10, h=10), render_box=Box(x=0, y=0, w=10, h=10),
              kind="text_bubble", source="こんにちは", translation="Xin chào",
              style=Style(color="#000000", stroke_color="#ffffff", stroke_width=0, font_px=20, font="dialogue"))
    r = TranslateResponse(width=10, height=10, inpainted_png="", resolved_source_lang="ja", blocks=[b], warnings=[])
    assert TranslateResponse.model_validate_json(r.model_dump_json()) == r
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** đúng hợp đồng API ở trên; `kind: Literal["text_bubble","text_free"]`, `font: Literal["dialogue","shout","narration"]`, `color` validate regex `^#[0-9a-f]{6}$`. Thêm `TranslateOptions(source_lang="auto", target_lang="vi", prev_context: list[str] = [] , max 20 phần tử)` và `TranslateResponse.resolved_source_lang: Literal["ja","ko","zh","en"]`.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `server: API schemas`.

### Task 3: Geometry + Detector (ogkalu RT-DETR-v2)

**Files:** Create `server/mt/geometry.py`, `server/mt/detector.py`; Test `server/tests/test_geometry.py`, `server/tests/test_detector.py`

Model card: classes `0: bubble`, `1: text_bubble`, `2: text_free`; train size 640; webtoon dài được cắt dọc khi train.

- [ ] **Step 1: Test fail cho hàm pure**

```python
# server/tests/test_geometry.py
from mt.geometry import tile_ranges, merge_boxes, contains, sort_reading_order
from mt.schemas import Box

def test_tile_ranges_short_image_single_tile():
    assert tile_ranges(width=800, height=1200) == [(0, 1200)]

def test_tile_ranges_webtoon_overlaps_and_covers():
    r = tile_ranges(width=800, height=10000)   # tile_h = 1.5*w = 1200, overlap 200
    assert r[0] == (0, 1200) and r[-1][1] == 10000
    assert all(b[0] < a[1] for a, b in zip(r, r[1:]))   # chồng lấn

def test_merge_boxes_dedups_overlap_from_two_tiles():
    a = (Box(x=10, y=1100, w=100, h=80), 1, 0.9)
    b = (Box(x=12, y=1102, w=98, h=78), 1, 0.8)
    assert len(merge_boxes([a, b], iou_thr=0.5)) == 1

def test_contains():
    assert contains(Box(x=0, y=0, w=100, h=100), Box(x=10, y=10, w=20, h=20))

def test_reading_order_manga_right_to_left():
    boxes = [Box(x=0, y=0, w=10, h=10), Box(x=100, y=0, w=10, h=10)]
    assert sort_reading_order(boxes, rtl=True) == [1, 0]
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `tile_ranges` (single tile nếu `height <= 2*width`; ngược lại tile_h = `int(1.5*width)`, overlap 200px, tile cuối kết thúc đúng `height`), `merge_boxes` (NMS theo class, giữ score cao), `contains` (≥ 80% diện tích box con nằm trong box cha), `sort_reading_order` (gom hàng theo `y` với dung sai 0.5×chiều cao trung vị, trong hàng sort `x` giảm nếu `rtl`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Implement detector**

```python
# server/mt/detector.py
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForObjectDetection
from .geometry import tile_ranges, merge_boxes
from .schemas import Box

MODEL_ID = "ogkalu/comic-text-and-bubble-detector"
LABELS = {0: "bubble", 1: "text_bubble", 2: "text_free"}

class ComicDetector:
    def __init__(self, threshold: float = 0.3, device: str | None = None):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.processor = AutoImageProcessor.from_pretrained(MODEL_ID)
        self.model = AutoModelForObjectDetection.from_pretrained(MODEL_ID).to(self.device).eval()
        self.threshold = threshold

    @torch.inference_mode()
    def detect(self, img: Image.Image) -> list[tuple[Box, str, float]]:
        found = []
        for y0, y1 in tile_ranges(img.width, img.height):
            tile = img.crop((0, y0, img.width, y1))
            inputs = self.processor(images=tile, return_tensors="pt").to(self.device)
            out = self.model(**inputs)
            res = self.processor.post_process_object_detection(
                out, target_sizes=torch.tensor([[tile.height, tile.width]]), threshold=self.threshold)[0]
            for (x0, ty0, x1, ty1), lbl, sc in zip(res["boxes"].tolist(), res["labels"].tolist(), res["scores"].tolist()):
                found.append((Box(x=int(x0), y=int(ty0) + y0, w=int(x1 - x0), h=int(ty1 - ty0)), int(lbl), float(sc)))
        return [(b, LABELS[l], s) for b, l, s in merge_boxes(found, iou_thr=0.5)]
```
Nếu repo HF không có `preprocessor_config.json`, thay bằng `RTDetrImageProcessor(size={"height": 640, "width": 640})` và ghi lại trong code comment.

- [ ] **Step 6: Integration test (slow)** `tests/test_detector.py` đánh dấu `@pytest.mark.slow`: dùng 1 ảnh manga mẫu đặt ở `server/tests/fixtures/page_ja.jpg` (tự chọn ảnh bạn sở hữu), assert có ít nhất 1 `text_bubble`. Thêm `markers = ["slow"]` vào `pyproject.toml`.
- [ ] **Step 7: Run** `pytest -m "not slow"` PASS, rồi `pytest -m slow` PASS. **Commit** `server: geometry + RT-DETR detector`.

### Task 4: OCR + page-level source language resolution (script fast-path)

**Files:** Create `server/mt/ocr.py`; Test `server/tests/test_ocr.py`

Mục tiêu v2 (đã hiệu chỉnh): **không đoán ngôn ngữ từ hình dạng block** và **không load 4 Paddle pipeline chỉ để đoán ngôn ngữ**. Probe 2 lớp:

- **Primary probe — fast path, đúng 1 model:** pipeline dùng chung `paddle:v5` = PP-OCRv5 mặc định (`PaddleOCR(lang="ch")`), native zh/en/ja. Đọc text của tối đa 3 crop đại diện, phân loại Unicode script, resolve ngay khi rõ ràng:
  - Kana ≥ 3 ký tự và ≥ 15% alphabetic → `ja`, evidence **high**
  - Hangul ≥ 3 ký tự và ≥ 15% alphabetic → `ko`, evidence **high**
  - Latin ≥ 80% alphabetic (alphabetic ≥ 5) → `en`, evidence **high**
  - Han có mặt, không kana/hangul → **ambiguous** (Han-only → secondary)
  - mean `rec_scores` của chính primary probe < 0.5 → text coi như junk → **ambiguous** (không tin script classification trên text lỗi)
- **Secondary probe — chỉ chạy khi ambiguous, tối đa thêm 1 model:**
  1. `split_han_only(text)` — free, không model: phân `ja`/`zh` bằng ký tự chỉ-giấy-tờ. zh-only simplified (们, 过, 这, 说, 题…) ≥ 3 ký tự riêng biệt → `zh`, evidence **medium**; ja-only shinjitai (駅, 桜, 沢, 弁, 図…) ≥ 2 ký tự riêng biệt → `ja`, evidence **medium**. Vẫn kẹt → bước 2.
  2. `paddle:korean` (`korean_PP-OCRv5_mobile_rec`, cover Korean + English) đọc lại 3 crop: có Hangul → `ko`, evidence **medium**.
  3. Còn lại → evidence **low**: Han-only → `zh`, ngược lại ngôn ngữ có số lượt ký tự alphabetic cao nhất; luôn kèm warning `source language auto-detection inconclusive (evidence=low); using <lang>`.
- **Evidence** là `Literal["high","medium","low","explicit"]` thay cho confidence số. **Không so `rec_scores` giữa các language model như calibrated probability**; score chỉ là junk-yield nội bộ của đúng model đó; quyết định `ko`/`ja`/`en`/`zh` bằng script evidence, không bằng so điểm giữa model.
- Engine map (`choose_engine`), instances lazy + cache theo key: `ja → manga_ocr`, `ko → paddle:korean`, `zh/en → paddle:v5`. `paddle:v5` và `paddle:korean` tải lúc probe **tái dùng** làm engine OCR chính → RAM tối đa 2 Paddle model + 1 manga-ocr cho mọi path.
- `requested != "auto"` → resolve ngay (`evidence="explicit"`), **không chạy probe nào, không tải model probe nào**.

> Bằng chứng cho giới hạn charset của primary (đã kiểm tra `ppocrv5_dict.txt` của PaddleOCR): 15565 han, 180 kana, 52 latin, **chỉ 2 ký tự Hangul**. Do đó trang Hàn Quốc luôn đi qua secondary probe — fast path vẫn resolve `ja`/`zh`/`en` (case phổ biến của manga) chỉ bằng 1 model.

- [ ] **Step 1: Test fail cho helper pure**

```python
# server/tests/test_ocr.py
from PIL import Image
from mt.ocr import (
    crop_with_padding, choose_engine, classify_scripts,
    resolve_from_probe, split_han_only, select_probe_crops, resolve_source_lang,
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

def test_classify_scripts_counts():
    ev = classify_scripts("안녕하세요 hello!")
    assert ev["hangul"] == 5 and ev["latin"] == 5 and ev["kana"] == 0

def test_resolve_kana_fast_path_high():
    assert resolve_from_probe("これはテストです。わろす", probe_confidence=0.9) == ("ja", "high")

def test_resolve_latin_fast_path_high():
    assert resolve_from_probe("I don't know what you mean, okay?", probe_confidence=0.9) == ("en", "high")

def test_resolve_hangul_fast_path_high():
    assert resolve_from_probe("오늘도 화이팅합니다", probe_confidence=0.9) == ("ko", "high")

def test_resolve_han_only_is_ambiguous():
    assert resolve_from_probe("这是一个测试", probe_confidence=0.9) == (None, "ambiguous")

def test_resolve_junk_probe_is_ambiguous():
    # junk-yield thấp → không tin script classification
    assert resolve_from_probe("안", probe_confidence=0.2) == (None, "ambiguous")

def test_split_han_only_finds_simplified_chinese():
    assert split_han_only("我们说过这个问题") == ("zh", "medium")

def test_split_han_only_finds_japanese_shinjitai():
    assert split_han_only("駅前桜沢弁図") == ("ja", "medium")

def test_split_han_only_shared_kanji_is_ambiguous():
    assert split_han_only("学校の先生") == (None, "ambiguous")   # có kana → không dùng split

def test_select_probe_crops_spans_page():
    boxes = [Box(x=0, y=0, w=10, h=10), Box(x=0, y=100, w=10, h=10),
             Box(x=0, y=200, w=10, h=10), Box(x=0, y=300, w=10, h=10)]
    picks = select_probe_crops(boxes, page_h=400, k=3)
    assert len(picks) == 3 and picks[0].y == 0 and picks[-1].y == 300 and len({b.y for b in picks}) == 3

def test_resolve_explicit_language_skips_probes():
    def boom(_):
        raise AssertionError("probe must not run when language is explicit")
    r = resolve_source_lang([], requested="ko", primary=boom, korean=boom)
    assert r.lang == "ko" and r.evidence == "explicit" and r.warnings == []

def test_resolve_ambiguous_falls_to_korean_probe():
    r = resolve_source_lang([], requested="auto",
                            primary=lambda _: ("ji zhe", 0.9),
                            korean=lambda _: "안녕하세요")
    assert (r.lang, r.evidence) == ("ko", "medium") and r.warnings == []

def test_resolve_low_evidence_warns():
    # han-only, không phân được ja/zh, korean probe không thấy Hangul
    r = resolve_source_lang([], requested="auto",
                            primary=lambda _: ("学校先生", 0.9),
                            korean=lambda _: ("nothing", 0.9))
    assert (r.lang, r.evidence) == ("zh", "low")
    assert r.warnings and "inconclusive" in r.warnings[0]
```

- [ ] **Step 2:** Run `pytest tests/test_ocr.py -v` → FAIL (`ImportError`).
- [ ] **Step 3: Implement data model** `OcrResult(text: str, confidence: float | None)`, `OcrEngine(Protocol).read(crop) -> OcrResult`, `ResolveResult(lang: str, evidence: Literal["high","medium","low","explicit"], warnings: list[str])`.
- [ ] **Step 4: Implement engines**
  - `PaddleOcrEngine(key)` với 2 key duy nhất: `paddle:v5` (`PaddleOCR(lang="ch")` — PP-OCRv5 mặc định, native zh/en/ja) và `paddle:korean` (`korean_PP-OCRv5`). `predict(...)` → join `rec_texts`, `confidence` = mean `rec_scores` của text không rỗng.
  - `MangaOcrEngine` trả text từ `MangaOcr()` và `confidence=None`.
  - Lazy cache instance theo key `manga_ocr`, `paddle:v5`, `paddle:korean`. Không còn key `paddle:japan` / `paddle:ch` / `paddle:en`.
  - Kiểm tra API/field thật (`rec_texts`, `rec_scores`, tên model PP-OCRv5) đúng với PaddleOCR version đã lock; nếu khác thì adapter chỉ sửa ở một chỗ.
- [ ] **Step 5: Implement pure script fast-path**
  - `classify_scripts(text) -> dict[str, int]` — đếm bằng Unicode range: Hangul `U+AC00–D7A3`, Kana `U+3040–30FFF` (kể cả prolonged sound mark `U+FF70`), Han `U+4E00–9FFF` + `U+3400–4DBF`, Latin `A-Za-z` + `U+00C0–024F`; bỏ whitespace, số, dấu punctuation khỏi denominator.
  - `resolve_from_probe(text, probe_confidence) -> tuple[str | None, Literal["high","ambiguous"]]` — đúng thứ tự kiểm tra: junk (`probe_confidence < 0.5`) → ambiguous; kana → `ja`; hangul → `ko`; latin → `en`; còn lại (han-only / rỗng / không rõ) → ambiguous. Ngưỡng như preamble.
  - `split_han_only(text) -> tuple[str | None, Literal["medium","ambiguous"]]` — nếu có kana/hangul → ambiguous (chỉ nhận Han thuần); đếm ký tự riêng biệt trong 2 bộ `ZH_ONLY` / `JA_ONLY` (khai báo ~100 ký tự/bộ trong file, comment nguồn: diff simplified-vs-traditional và shinjitai-vs-traditional); vượt ngưỡng ở preamble thì trả `("zh","medium")` / `("ja","medium")`, không thì ambiguous.
- [ ] **Step 6: Implement orchestration**
  - `select_probe_crops(text_boxes, page_h, k=3) -> list[Box]` — sắp theo diện tích giảm, chọn phân bố trên/giữa/dưới trang, tối đa `k`.
  - `resolve_source_lang(crops, requested, primary, korean) -> ResolveResult`, `primary`/`korean` là callable `list[PIL.Image] -> (text, confidence)` (pipeline truyền engine thật; test truyền lambda — không cần model):
    - `requested != "auto"` → `(requested, "explicit", [])`, không gọi probe.
    - gọi `primary` một lần → `resolve_from_probe` → resolved thì trả.
    - ambiguous → `split_han_only` trên cùng text → resolved (`medium`) thì trả.
    - vẫn ambiguous → gọi `korean` → text có Hangul (≥ 3, ≥ 15% alphabetic) → `("ko", "medium", [])`.
    - cuối cùng → evidence `low` như preamble + warning.
- [ ] **Step 7:** Unit tests PASS (`pytest tests/test_ocr.py -v`). Thêm slow fixtures `page_ja`, `page_ko`, `page_en` (ảnh hợp pháp) assert resolved language đúng — trang `page_ko` sẽ đi qua korean probe, đây là regression chính của fast-path. **Commit** `server: OCR engines and script fast-path language resolution`.

### Task 5: Translator — Vision LLM nhìn ảnh + OCR, hỗ trợ webtoon dài

**Files:** Create `server/mt/translator.py`; Test `server/tests/test_translator.py`

Manga/page thường: vẽ `id` lên ảnh gốc annotated, resize cạnh dài tối đa 1600px, JPEG q=85. Webtoon dài (`height > 3 * width`): tạo **1 overview** nhỏ để model hiểu flow tổng thể + nhiều **vertical tile annotated** theo `tile_ranges`; mỗi tile giữ độ phân giải đủ đọc text/biểu cảm. Tất cả image parts nằm trong **cùng một `/chat/completions` request** cùng danh sách `id: OCR text`.

Prompt yêu cầu AI dùng visual để hiểu ngữ cảnh/cảm xúc/người nói, sửa lỗi OCR khi visual đủ rõ, chọn đại từ xưng hô tiếng Việt phù hợp quan hệ nhân vật, giữ tên riêng nhất quán và dịch ngắn gọn vừa bubble. `prev_context` ≤ 20 dòng được đưa vào prompt.

- [ ] **Step 1: Test fail**

```python
# server/tests/test_translator.py
import httpx, json, pytest
from PIL import Image
from mt.schemas import Box
from mt.translator import (
    parse_translations, build_messages, build_vision_images,
    LlmTranslator, TranslationError
)

def test_parse_plain_json():
    assert parse_translations('{"translations":[{"id":1,"text":"Chào"}]}', {1}) == {1: "Chào"}

def test_parse_fenced_json_and_ignores_unknown_ids():
    raw = 'Đây:
```json
{"translations":[{"id":1,"text":"A"},{"id":9,"text":"B"}]}
```'
    assert parse_translations(raw, {1, 2}) == {1: "A"}

def test_parse_garbage_returns_empty():
    assert parse_translations("xin lỗi tôi không thể", {1}) == {}

def test_normal_page_builds_one_vision_image():
    img = Image.new("RGB", (800, 1200), "white")
    vis = build_vision_images(img, [(1, Box(x=10,y=10,w=50,h=80))])
    assert len(vis) == 1

def test_long_webtoon_builds_overview_plus_tiles():
    img = Image.new("RGB", (800, 10000), "white")
    vis = build_vision_images(img, [(1, Box(x=10,y=100,w=50,h=80)), (2, Box(x=20,y=9000,w=50,h=80))])
    assert len(vis) > 2
    assert all(max(v.size) <= 1600 for v in vis)

def test_messages_contain_all_images_and_ids():
    imgs = [Image.new("RGB", (100, 100)), Image.new("RGB", (100, 100))]
    msgs = build_messages(imgs, [(1, "こんにちは")], "ja", "vi", ["câu trước"])
    user = msgs[-1]["content"]
    assert sum(p["type"] == "image_url" for p in user) == 2
    assert "1: こんにちは" in next(p["text"] for p in user if p["type"] == "text")

def _translator(handler):
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return LlmTranslator("http://llm", "k", "m", client=client)

def test_translate_success():
    def h(req):
        body = json.loads(req.content)
        assert body["model"] == "m"
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"translations":[{"id":1,"text":"Xin chào"}]}'}}]})
    out = _translator(h).translate(Image.new("RGB", (50, 50)), [(1, Box(x=0,y=0,w=20,h=20), "こんにちは")], "ja", "vi", [])
    assert out == {1: "Xin chào"}

def test_translate_retries_once_on_bad_json_then_returns_partial():
    calls = []
    def h(req):
        calls.append(1)
        return httpx.Response(200, json={"choices": [{"message": {"content": "???"}}]})
    assert _translator(h).translate(Image.new("RGB", (50, 50)), [(1, Box(x=0,y=0,w=20,h=20), "x")], "ja", "vi", []) == {}
    assert len(calls) == 2

def test_translate_http_error_raises():
    t = _translator(lambda req: httpx.Response(429, json={"error": "quota"}))
    with pytest.raises(TranslationError, match="429"):
        t.translate(Image.new("RGB", (50, 50)), [(1, Box(x=0,y=0,w=20,h=20), "x")], "ja", "vi", [])
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement visual preparation**
  - `annotate_region(img, blocks, y0=0)` vẽ nhãn `id` rõ (nền đỏ/đen, chữ trắng), không che nội dung OCR nếu có thể.
  - `resize_max_edge(img, 1600)` giữ aspect ratio.
  - `build_vision_images(page, blocks)`:
    - nếu `height <= 3*width`: annotated full page → resize max 1600 → `[image]`.
    - nếu dài: tạo overview toàn page max edge 1600 **chỉ để global context**; sau đó crop các vertical tile theo `tile_ranges`; annotate ID có tâm nằm trong tile, resize tile max 1600; trả `[overview, tile1, tile2, ...]`.
    - đặt safety cap `MAX_VISION_IMAGES` (vd 12). Nếu vượt, tăng tile height/giảm overlap nhưng vẫn phải cover toàn page; ghi warning nếu phải coarsen.
  - Encode từng ảnh JPEG q=85 thành data URL.
- [ ] **Step 4: `build_messages(images, items, src, tgt, prev_context)`** → system + user content gồm text trước rồi toàn bộ `image_url`. Text phải nói rõ ảnh đầu có thể là overview, các ảnh sau là tile cùng một page, ID là global.
- [ ] **Step 5: `parse_translations(raw, valid_ids)`**: `json.loads`; nếu lỗi, bỏ markdown fence/tìm object `{...}`; bỏ id lạ/text rỗng. Không eval.
- [ ] **Step 6: `LlmTranslator.translate`**
  - `PROMPT_VERSION = "2"` export từ module để dùng trong cache key.
  - POST `{base}/chat/completions`, `temperature=0.3`, timeout setting.
  - HTTP != 200 hoặc network error → `TranslationError`; body log/trả tối đa 200 chars, không log API key.
  - JSON invalid → retry đúng 1 lần với corrective instruction `Return only valid JSON matching the required schema`; retry vẫn invalid → trả partial parse (có thể `{}`).
- [ ] **Step 7:** tests PASS. **Commit** `server: tiled vision LLM translator`.

### Task 6: Style estimation (màu chữ, viền, cỡ chữ)

**Files:** Create `server/mt/style.py`; Test `server/tests/test_style.py`

Mặc định `kmeans` (nhanh, không cần torch thêm). **Hàm style luôn nhận ảnh gốc, chưa inpaint.** `yuzu` là tuỳ chọn: YuzuMarker dự đoán font + màu chữ, màu viền, độ dày viền, góc; model pretrained ở `huggingface.co/gyrojeff/YuzuMarker.FontDetection` và cần PyTorch 2.x. Font CJK nó dự đoán không dùng được cho tiếng Việt nên chỉ lấy màu/viền/kích thước, còn font map sang 3 font Việt.

- [ ] **Step 1: Test fail**

```python
# server/tests/test_style.py
from PIL import Image, ImageDraw
from mt.style import estimate_style
from mt.schemas import Box

def _sample(fg, bg):
    img = Image.new("RGB", (120, 60), bg)
    ImageDraw.Draw(img).rectangle((20, 20, 100, 40), fill=fg)   # "nét chữ"
    return img

def test_black_text_on_white():
    s = estimate_style(_sample((0, 0, 0), (255, 255, 255)), Box(x=0, y=0, w=120, h=60), kind="text_bubble", line_count=1)
    assert s.color == "#000000" and s.font == "dialogue"

def test_white_text_on_dark_gets_dark_stroke():
    s = estimate_style(_sample((255, 255, 255), (20, 20, 20)), Box(x=0, y=0, w=120, h=60), kind="text_free", line_count=1)
    assert s.color == "#ffffff" and s.stroke_width > 0 and s.stroke_color == "#000000"
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `estimate_style(page, box, kind, line_count)`: crop box, k-means 2 cụm (`cv2.kmeans`) trên pixel; cụm ít pixel hơn = màu chữ, cụm nhiều = nền; làm tròn màu gần đen/trắng (khoảng cách < 40 → `#000000`/`#ffffff`). `stroke_width = 3` và `stroke_color` = màu tương phản nếu `kind == "text_free"` hoặc nền tối (luminance < 0.4), ngược lại 0. `font_px = clamp(box.h / max(line_count,1) * 0.8, 12, 72)` (chỉ là gợi ý ban đầu, extension sẽ fit lại). `font`: `"narration"` nếu nền không phải trắng và là hình chữ nhật (`kind=="text_bubble"` và bubble chữ nhật bỏ qua ở v1), `"shout"` nếu `text_free` và chữ to (box.h > 8% chiều cao trang), còn lại `"dialogue"`.
- [ ] **Step 4: Run** → PASS. **Commit** `server: style estimation`.
- [ ] **Step 5 (optional, sau khi E2E chạy): `YuzuStyleEstimator`** — tải checkpoint từ HF, load `ResNet*Regressor` như `demo.py` của YuzuMarker. Đọc `font_dataset/fontlabel.py` để chốt đúng index trong vector output (trong `detector/data.py`: `[2:5]` màu chữ, `[7:10]` màu viền, `[10]` độ dày viền, `[11]` góc). Trả cùng kiểu `Style`. Bật bằng `STYLE_ENGINE=yuzu`; test slow so màu với ảnh fixture.

### Task 7: Inpainting

**Files:** Create `server/mt/inpaint.py`; Test `server/tests/test_inpaint.py`

Detector chỉ cho bbox, nên tự tạo mask nét chữ: trong mỗi text box, Otsu threshold tách nét chữ khỏi nền, dilate 3px. `text_bubble` (nền gần đồng màu) → `cv2.inpaint(..., cv2.INPAINT_TELEA)` là đủ nhanh. `text_free` (chữ đè lên hình) → LaMa nếu `INPAINTER=lama` (`simple-lama-inpainting`, cài thêm), không thì vẫn dùng TELEA.

- [ ] **Step 1: Test fail**

```python
# server/tests/test_inpaint.py
import numpy as np
from PIL import Image, ImageDraw
from mt.inpaint import text_mask, OpenCvInpainter
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
    out = OpenCvInpainter().inpaint(page, [(Box(x=40, y=30, w=120, h=40), "text_bubble")])
    assert np.asarray(out)[30:70, 40:160].min() > 200
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `text_mask`, `OpenCvInpainter.inpaint(page, blocks)`, `LamaInpainter` (lazy import `from simple_lama_inpainting import SimpleLama`, gọi `SimpleLama()(image, mask)` chỉ cho vùng `text_free`, crop vùng + 32px để nhanh).
- [ ] **Step 4: Run** → PASS. **Commit** `server: inpainting`.

### Task 8: Pipeline, stage cache, image safety, endpoint `/translate`

**Files:** Create `server/mt/pipeline.py`, `server/mt/cache.py`, `server/mt/__main__.py`; Modify `server/mt/app.py`; Test `server/tests/test_pipeline.py`, `server/tests/test_cache.py`, `server/tests/test_app.py`

#### Pipeline order — phải giữ đúng

`Pipeline.run(image_bytes, opts)`:

1. Kiểm tra `len(image_bytes) <= max_image_bytes`; quá → `ImageTooLargeError` → HTTP `413`.
2. `Image.open(BytesIO(...))`, đọc `width,height` **trước `.convert("RGB")`**; reject nếu `max(width,height) > max_dimension` hoặc `width*height > max_pixels`; sau đó mới `load()/convert("RGB")`.
3. Resolve **perception cache key** từ `sha256(image_bytes) + requested source_lang + detector id/version/threshold + OCR config + style engine + inpainter + PIPELINE_VERSION`.
4. Perception cache hit → lấy metadata + `inpainted.png`, bỏ qua detect/OCR/style/inpaint.
5. Cache miss: Detect → tách `bubble`, `text_bubble`, `text_free`.
6. Không có text candidate → lưu perception result rỗng, trả ảnh gốc/inpainted original + `blocks=[]`; **không gọi LLM**.
7. Resolve `source_lang` ở cấp page (`Task 4`), sau đó OCR từng text box bằng engine tương ứng; bỏ OCR rỗng.
8. Gán `render_box`: text nằm trong bubble → bubble box co 12% mỗi cạnh; không → text box.
9. Sort reading order (`rtl=True` chỉ khi resolved language là `ja`; Korean/Chinese/English mặc định LTR trong v1), đánh `id=1..n`.
10. **Estimate style trên ảnh gốc** cho từng block. Không được inpaint trước bước này.
11. Inpaint từ ảnh gốc → binary PNG. Lưu perception metadata JSON + `.png` vào cache.
12. Build **translation cache key** từ `perception_key + resolved_source_lang + target_lang + llm_model + PROMPT_VERSION + normalized prev_context`.
13. Translation cache hit → dùng translations ngay. Miss → gọi Vision LLM bằng **ảnh gốc annotated/tiled** + OCR + context; lưu translation JSON.
14. Block thiếu translation → `translation=source`, warning `missing translation for id N`.
15. Assemble `TranslateResponse` gồm `resolved_source_lang`, encode binary inpainted PNG thành base64 **chỉ tại API boundary**.

#### Cache layout

```text
server/.cache/
  perception/
    <key>.json
    <key>.inpainted.png
  translation/
    <key>.json
```

Không nhét PNG base64 vào cache JSON.

- [ ] **Step 1: Test fail với fake components**

```python
# server/tests/test_pipeline.py
import io, pytest
from PIL import Image
from mt.pipeline import Pipeline, ImageTooLargeError
from mt.schemas import Box, TranslateOptions

class FakeDet:
    def __init__(self, items): self.items = items; self.calls = 0
    def detect(self, img): self.calls += 1; return self.items

class FakeOcr:
    def read(self, crop):
        from mt.ocr import OcrResult
        return OcrResult(text="テキスト", confidence=0.9)

class FakeTr:
    def __init__(self): self.calls = 0
    def translate(self, img, items, src, tgt, ctx):
        self.calls += 1
        return {items[0][0]: "Chữ"}

def _png(size=(300,300)):
    b = io.BytesIO(); Image.new("RGB", size, "white").save(b, "PNG"); return b.getvalue()

def test_no_text_skips_llm(tmp_path):
    tr = FakeTr()
    p = make_pipeline(tmp_path, detector=FakeDet([(Box(x=0,y=0,w=100,h=100), "bubble", .9)]), translator=tr)
    r = p.run(_png(), TranslateOptions(source_lang="ja"))
    assert r.blocks == [] and tr.calls == 0

def test_style_is_measured_before_inpaint(tmp_path):
    seen = {}
    def style_fn(page, box, kind, line_count):
        seen["pixel"] = page.getpixel((0, 0))
        return fake_style()
    class BlackInpainter:
        def inpaint(self, page, blocks):
            return Image.new("RGB", page.size, "black")
    p = make_pipeline(tmp_path, style_estimator=style_fn, inpainter=BlackInpainter())
    p.run(_png(), TranslateOptions(source_lang="ja"))
    assert seen["pixel"] == (255, 255, 255)

def test_same_context_hits_translation_cache(tmp_path):
    tr = FakeTr(); p = make_pipeline(tmp_path, translator=tr)
    opts = TranslateOptions(source_lang="ja", prev_context=["A"])
    p.run(_png(), opts); p.run(_png(), opts)
    assert tr.calls == 1

def test_changed_context_misses_translation_only(tmp_path):
    det = FakeDet(default_text_items()); tr = FakeTr()
    p = make_pipeline(tmp_path, detector=det, translator=tr)
    p.run(_png(), TranslateOptions(source_lang="ja", prev_context=["A"]))
    p.run(_png(), TranslateOptions(source_lang="ja", prev_context=["B"]))
    assert det.calls == 1       # perception reused
    assert tr.calls == 2        # translation invalidated

def test_rejects_too_many_pixels_before_rgb_decode(tmp_path):
    p = make_pipeline(tmp_path, max_pixels=10_000)
    with pytest.raises(ImageTooLargeError):
        p.run(_png((200,200)), TranslateOptions(source_lang="ja"))
```

> `make_pipeline`, `default_text_items`, `fake_style` là test helpers trong chính `tests/test_pipeline.py`; production code không được biết fake components.

- [ ] **Step 2: Implement `StageCache`**
  - atomic write: ghi temp rồi `os.replace` để crash không tạo file JSON/PNG nửa chừng.
  - corrupted/missing pair (`.json` có nhưng `.png` mất, JSON invalid) → cache miss; không crash request.
  - normalized context trước hash: strip, NFC, lấy tối đa 20 lines theo schema.
- [ ] **Step 3: Implement pipeline theo thứ tự 1–15 ở trên.** `PIPELINE_VERSION="2"`; import `PROMPT_VERSION` từ translator. Dùng lock quanh inference components không thread-safe/GPU; không lock toàn request nếu không cần.
- [ ] **Step 4: Endpoint `/translate`**
  - đọc `UploadFile` với hard cap bytes (không tin `Content-Length`); parse `options` JSON bằng `TranslateOptions`.
  - chạy blocking pipeline qua `run_in_threadpool`.
  - map unsupported image → `400`; `ImageTooLargeError` → `413`; `TranslationError` → `502`; validation options → `422`/`400` nhất quán và test.
- [ ] **Step 5: Endpoint tests**: token đúng + fake pipeline → `200`; wrong token → `401`; `TranslationError("LLM 429: quota")` → `502` có `429`; invalid image → `400`; oversize → `413`; `/auth-check` đúng/sai token.
- [ ] **Step 6:** `pytest -m "not slow"` PASS.
- [ ] **Step 7: `__main__.py`** build real components lazily, `uvicorn.run(app, host=settings.host, port=settings.port)`. Manual curl manga Nhật và webtoon dài; log chỉ timing/cache hit, không log token/API key/raw private image bytes.
- [ ] **Step 8:** Commit `server: safe pipeline and stage cache`.

---

## Phase B — Chrome Extension

### Task 9: Scaffold extension + settings + token-safe storage

**Files:** Create `extension/package.json`, `tsconfig.json`, `build.mjs`, `manifest.json`, `src/types.ts`, `src/settings.ts`, `src/options.html`, `src/options.ts`; Test `extension/tests/settings.test.ts`

- [ ] **Step 1:** `cd extension && npm init -y && npm i -D --save-exact typescript esbuild vitest @types/chrome`. Scripts: `build`, `test`, `typecheck`.
- [ ] **Step 2:** `build.mjs` bundle `background.ts`, `content.ts`, `options.ts`; copy manifest/options/fonts.
- [ ] **Step 3:** Manifest MV3 giữ `storage`, `declarativeNetRequest`, `contextMenus`, `<all_urls>`, service worker module, content script, options page, fonts resource, command `Alt+T`.
- [ ] **Step 4: Types** khớp API v2, gồm `resolved_source_lang`.
- [ ] **Step 5: Storage split**
  - `chrome.storage.sync`: `{serverUrl, sourceLang, targetLang, autoSites}`.
  - `chrome.storage.local`: `{token}`.
  - helper `loadSettings()` merge hai nguồn thành object dùng runtime; không bao giờ ghi token sang sync.
  - test mock Chrome storage: save/load đảm bảo token chỉ xuất hiện trong `local.set`.
- [ ] **Step 6: Options page**
  - nút `Kiểm tra kết nối` gọi `/health`; nếu fail → `Server local chưa chạy`.
  - nếu health OK, gọi `/auth-check` với `X-MT-Token`; `401` → `Server chạy nhưng token sai`; `200` → `Kết nối và token hợp lệ`.
  - label tiếng Việt có `<label for>`, không render token vào DOM ngoài input password.
- [ ] **Step 7:** `npm test && npm run build && npm run typecheck` PASS; load unpacked không lỗi. **Commit** `extension: scaffold and safe settings`.

### Task 10: Layout engine (pure)

**Files:** Create `extension/src/layout.ts`; Test `extension/tests/layout.test.ts`

- [ ] **Step 1: Test fail**

```ts
import { describe, it, expect } from "vitest";
import { wrapText, fitText, type Measure } from "../src/layout";

const m: Measure = (t, px) => t.length * px * 0.5;

describe("wrapText", () => {
  it("wraps by words", () => {
    expect(wrapText("xin chào bạn nhé", 50, 10, m)).toEqual(["xin chào", "bạn nhé"]);
  });
  it("breaks a word longer than the line", () => {
    expect(wrapText("AAAAAAAAAAAA", 30, 10, m).every(l => m(l, 10) <= 30)).toBe(true);
  });
});

describe("fitText", () => {
  it("picks the largest size that fits", () => {
    const r = fitText("xin chào bạn", { w: 100, h: 60 }, m, { minPx: 8, maxPx: 64, lineHeight: 1.2 });
    const h = r.lines.length * r.fontPx * 1.2;
    expect(h).toBeLessThanOrEqual(60);
    expect(r.lines.every(l => m(l, r.fontPx) <= 100)).toBe(true);
    expect(fitText("xin chào bạn", { w: 100, h: 60 }, m, { minPx: 8, maxPx: r.fontPx + 1, lineHeight: 1.2 }).fontPx).toBe(r.fontPx);
  });
  it("never goes below minPx and flags overflow", () => {
    const r = fitText("chữ ".repeat(200), { w: 40, h: 20 }, m, { minPx: 10, maxPx: 64, lineHeight: 1.2 });
    expect(r.fontPx).toBe(10);
    expect(r.overflow).toBe(true);
  });
});
```
- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement** `wrapText` (tách theo khoảng trắng, word dài cắt theo ký tự, xử lý chuỗi đã NFC), `fitText` (binary search số nguyên `[minPx, maxPx]`, trả `{fontPx, lines, overflow}`).
- [ ] **Step 4: Run** → PASS. **Commit** `extension: text layout`.

### Task 11: Renderer — responsive font sizing, không hard-cap 64px

**Files:** Create `extension/src/render.ts`, `extension/fonts/*.woff2`

- [ ] **Step 1:** Bundle 3 font có Vietnamese subset + OFL license.
- [ ] **Step 2: Implement `composePage(resp)`**
  - load `FontFace` một lần; cache promise.
  - decode `inpainted_png`, vẽ vào `OffscreenCanvas(resp.width, resp.height)`.
  - với mỗi block, chọn font family theo `style.font`.
  - `style.font_px` chỉ là **hint**, không phải upper bound. Tính:

```ts
const geometricMax = Math.max(16, Math.floor(block.render_box.h * 0.80));
const hintedMax = Math.max(16, Math.floor(block.style.font_px * 1.6));
const maxPx = Math.min(180, Math.max(geometricMax, hintedMax));
const minPx = Math.max(10, Math.min(18, Math.floor(block.render_box.h * 0.08)));
```

  - `fitText` binary search trong `[minPx,maxPx]`; center ngang/dọc.
  - `strokeText` trước `fillText`, `lineJoin="round"`.
  - nếu `overflow=true`, vẫn render ở minPx nhưng thêm console/debug warning; không throw làm hỏng cả page.
  - `canvas.convertToBlob({type:"image/png"})`.
- [ ] **Step 3:** Manual fixture ở nhiều resolution: manga ~1200×1800 và webtoon dài; Vietnamese dấu đúng, font không quá nhỏ chỉ vì source style bị clamp 72px. **Commit** `extension: responsive canvas renderer`.

### Task 12: Content script — discovery, sequential translate queue, context-safe ordering

**Files:** Create `extension/src/discover.ts`, `extension/src/content.ts`; Test `extension/tests/discover.test.ts`

- [ ] **Step 1: Discovery tests** bằng jsdom: ưu tiên `data-src`/`data-original`/`data-lazy-src`; chọn candidate lớn nhất từ `srcset`; resolve URL tương đối; bỏ data placeholder; bỏ ảnh nhỏ; bỏ ảnh `data-mt-state=pending|done` và blob do extension tạo.
- [ ] **Step 2:** Implement `resolveImageUrl` + `isMangaCandidate`; tests PASS.
- [ ] **Step 3: UI**
  - hover/focus ảnh hợp lệ → nút `Dịch`; keyboard accessible.
  - auto site/`Alt+T`: `IntersectionObserver(rootMargin:"1500px 0px")` chỉ **enqueue** candidate, không gửi song song.
  - error badge giữ ảnh gốc, click retry.
  - hold click hoặc `Alt+O` hiện ảnh gốc tạm thời.
- [ ] **Step 4: Per-tab queue concurrency = 1**
  - `content.ts` giữ FIFO theo DOM order; dedupe bởi canonical image URL + current element.
  - chỉ dispatch job tiếp theo sau khi job hiện tại đã resolve/reject.
  - `prevContext` lấy **ngay trước khi dispatch** từ 20 dòng translation đã hoàn tất, không snapshot khi enqueue.
  - vì vậy page N+1 luôn nhận context sau page N nếu cả hai nằm trong auto queue.
  - manual click cũng vào cùng queue để không phá ordering; có thể ưu tiên manual lên đầu nhưng không chạy song song.
- [ ] **Step 5: Success path**
  - gửi `{type:"translate", url, pageUrl, prevContext}` tới background; set pending/spinner.
  - nhận response → `composePage` → object URL; lưu original URL/srcset cần thiết; swap image; state done.
  - append translations theo block order vào rolling context tối đa 20 dòng.
  - revoke old object URL khi image reset/DOM removed để tránh leak.
- [ ] **Step 6: MutationObserver**: nếu site thay source của element đã dịch do virtualized/lazy loader, restore state hợp lý, revoke blob cũ, re-evaluate URL; không loop do chính extension đổi `src`.
- [ ] **Step 7:** `npm test && npm run typecheck` PASS. **Commit** `extension: context-safe content queue`.

### Task 13: Background service worker — fetch ảnh, hotlink retry, server call

**Files:** Create `extension/src/background.ts`, `extension/src/referer.ts`; Test `extension/tests/referer.test.ts`

- [ ] **Step 1: `buildRefererRule` test**: exact image URL, `modifyHeaders`, set `Referer=pageUrl`, resource types `xmlhttprequest/other`, initiator extension khi runtime hỗ trợ.
- [ ] **Step 2: Implement `referer.ts`**; rule ID allocator không collision giữa concurrent fetch ở các tab.
- [ ] **Step 3: `fetchImage(url,pageUrl)`**
  1. normal `fetch(url,{credentials:"include"})`;
  2. nếu `401/403`, add temporary session rule set Referer → retry cùng credentials;
  3. `finally` luôn remove rule;
  4. retry vẫn fail → throw explicit `Không tải được ảnh (HTTP N)`.
  - validate response `ok`, MIME hợp lý hoặc ít nhất Blob có bytes; không silently POST HTML error page sang server.
- [ ] **Step 4: Deduplication**: job trùng exact canonical URL đang chạy có thể share **fetch promise**, nhưng không share translation promise nếu `prevContext` khác. Translation ordering vẫn thuộc content script.
- [ ] **Step 5: Call server**
  - load latest settings + token; `FormData(image, options)`; `X-MT-Token`.
  - timeout 120s `AbortController`.
  - map connect error → `Server local chưa chạy (python -m mt)`; `401` → `Sai token`; `413` → `Ảnh quá lớn`; `502` → server `detail`; timeout → message riêng.
- [ ] **Step 6:** Context menu `Dịch ảnh này` gửi command tới content script để **enqueue** ảnh, không bypass sequential queue.
- [ ] **Step 7:** `npm test && npm run build && npm run typecheck` PASS. **Commit** `extension: resilient image fetch and server bridge`.

### Task 14: End-to-end + regression matrix

- [ ] **Step 1:** Chạy server; load `extension/dist`; Options phải phân biệt được ba trạng thái: server down / server up token sai / server up token đúng.
- [ ] **Step 2: Manga Japanese page**
  - detect/OCR/translation đúng cơ bản;
  - style gần source và được lấy trước inpaint;
  - chữ Việt không tràn, font không bị nhỏ bất thường trên ảnh high-res.
- [ ] **Step 3: Korean long webtoon**
  - detector cover từ đầu tới cuối;
  - `source_lang=auto` resolve đúng ngôn ngữ; evidence low phải warning rõ (không silently đoán);
  - log/debug translator cho thấy **1 LLM request chứa >1 image part** (overview + tiles), không phải một ảnh 128×1600;
  - bubble ở phần cuối vẫn được dịch.
- [ ] **Step 4: Context ordering**: enqueue liên tiếp 3 ảnh; xác nhận request thứ 2 chỉ bắt đầu sau response thứ 1 và options của request 2 chứa context từ request 1.
- [ ] **Step 5: Cache regression**
  - gọi cùng ảnh/context/model → perception + translation hit;
  - đổi `prev_context` → perception hit nhưng translation miss;
  - đổi `LLM_MODEL`/`PROMPT_VERSION` → perception hit, translation miss;
  - cache corrupt/missing PNG → recompute thay vì crash.
- [ ] **Step 6: Failure cases**
  - server off → badge lỗi, page không vỡ; bật lại retry được;
  - token sai → message chính xác;
  - LLM 429/timeout → 502 surfaced rõ;
  - ảnh không chữ → không có LLM request;
  - ảnh vượt max pixels → 413 trước RGB decode;
  - hotlink site → Referer retry hoạt động và rule được cleanup.
- [ ] **Step 7:** Chrome Task Manager + server RSS: dịch webtoon dài không tăng RAM vô hạn qua nhiều ảnh; kiểm tra object URL được revoke.
- [ ] **Step 8:** Ghi lỗi thật thành tasks mới, update README/run guide. **Commit** `docs: e2e and regression notes`.

---

## Sau v1 (không làm trong plan này)

- **ONNX detector backend:** thêm `DETECTOR_BACKEND=torch|onnx`; benchmark CPU bằng ONNX/INT8 trước khi đổi mặc định.
- Bật `YuzuStyleEstimator` và/hoặc `LamaInpainter` mặc định nếu hardware đủ và chất lượng E2E chứng minh tốt hơn.
- Glossary/tên nhân vật theo series (`domain + normalized series path`) và đưa glossary version vào translation cache key.
- Dịch cả chapter trong một request/batch strategy để context tốt hơn; chỉ làm sau khi page-level pipeline ổn.
- Translation memory theo source text + series context để tiết kiệm LLM cost.
- Optional fast mode: cho phép >1 translation concurrent/tab **chỉ khi user chấp nhận context best-effort**; quality mode vẫn sequential.
- Native Messaging host thay HTTP localhost nếu sau này muốn đóng gói extension/server thành app cài đặt hoàn chỉnh.
