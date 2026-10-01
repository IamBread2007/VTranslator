# E2E + regression notes (Task 14)

Ngày chạy: 2026-10-01. Môi trường: Windows, Chrome/Chromium 154, server
`127.0.0.1:8765` (`LLM_MODEL=agy/gemini-3.8-flash-high`), extension loaded unpacked
từ `extension/dist` qua `--load-extension` (Playwright Chromium, port 9334).

## Step 1 — Options 3 trạng thái

| Trạng thái | Kết quả |
| --- | --- |
| Server down (`127.0.0.1:8799`) | curl exit 28 (timeout); extension: badge đỏ + console `MT translate failed: Error: Server local chưa chạy (python -m mt)` |
| Token sai | `GET /auth-check` → 401; `/translate` → 401 `{"detail":"invalid token"}`; extension: badge + `Sai token — kiểm tra trong Settings` |
| Token đúng | `/auth-check` → `{"ok":true}`; extension: `state=done`, không badge |

Retry qua badge hoạt động: sau khi sửa Options (trạng thái `Đã lưu`), Alt+T lại →
`state=done`, ảnh swap sang `blob:` 849×1200.

## Step 2 — Manga Nhật (live)

- `/translate` ảnh thật (`mangaPanelForTesting.jpg`, 849×1200): `resolved=ja`,
  11 blocks, `warnings=[]`, 21.79s cold; cache hit 0.05s.
- Render thật trong Chrome (compose harness dùng `src/render.ts` nguyên vẹn):
  `COMPOSE-OK 849x1200 overflow=[]`; pixel-diff 11/11 block thay đổi (>600 px mỗi
  block, 0 block rỗng); `document.fonts` load đủ `MT Patrick Hand`, `MT Bangers`,
  `MT Be Vietnam Pro`; band dấu tiếng Việt `"Nước Việt Nam đủ dấu"` vẽ 423 pixel
  phía trên x-height (không tofu); 11/11 block fit `overflow:false`, fontPx 27–72.
- Browser E2E đầy đủ (extension thật): pixel-diff ảnh gốc vs ảnh sau swap =
  `{"changed":63719,"total":1018800}` — chữ Việt đã vẽ vào ảnh trên trang.

## Step 3 — Webtoon Hàn dọc (live)

- Fixture mới `server/tests/fixtures/page_ko_tall.jpg` (700×2400, sinh bằng
  `malgun.ttf`, bubble top→bottom).
- `/translate` `source_lang=auto`: 36.3s, `resolved=ko`, 6/6 blocks dịch — block
  đáy `y=2135` vẫn dịch, `warnings=[]`.
- LLM request nhiều ảnh (overview + tiles) bao phủ bởi unit
  `test_long_webtoon_builds_overview_plus_tiles` và
  `test_messages_contain_all_images_and_ids` (không log LLM request ra ngoài ở live).

## Step 4 — Thứ tự context (live + unit)

- CDP Network log từ service worker (2 ảnh, Alt+T):
  `req1 t=3.046 → resp1 200 t=3.073 → req2 t=3.411 → resp2 200 t=3.425` —
  request 2 chỉ bắt đầu sau response 1 (`ORDER-OK sequential`).
- Context có ảnh hưởng thật: gửi `prev_context` khác → 7.9–11.3s (translation miss,
  perception hit); cùng context → 0.02–0.06s (hit).
- Unit: queue FIFO/concurrency 1 (`tests/discover.test.ts`), `prevContext` đọc ngay
  trước dispatch (`content.ts`), messages chứa đủ ảnh + ids
  (`test_messages_contain_all_images_and_ids`).

## Step 5 — Cache regression

| Case | Kết quả |
| --- | --- |
| Cùng ảnh/context/model | hit 0.02–0.06s |
| Đổi `prev_context` | 11.32s — perception hit, translation miss (unit `test_changed_context_misses_translation_only`) |
| Đổi `LLM_MODEL` | unit `test_changed_llm_model_misses_translation_only`: `det.calls==1`, `tr.calls==2` |
| Cache corrupt/missing PNG | unit `tests/test_cache.py`: miss → recompute, không crash |

## Step 6 — Failure cases

| Case | Kết quả |
| --- | --- |
| Server off | live: badge + `Server local chưa chạy (python -m mt)`, page không vỡ; bật lại → retry `done` ✅ |
| Token sai | live: badge + `Sai token — kiểm tra trong Settings`; curl 401 ✅ |
| LLM 429/timeout → 502 | unit `test_translate_llm_error_502` |
| Ảnh không chữ → không gọi LLM | unit `test_no_text_skips_llm` |
| Vượt max pixels/bytes → 413 trước decode | unit endpoint 413 + bounds (`25MB`, `30MP`, `20.000` px) |
| Hotlink Referer retry + cleanup | unit: `tests/referer.test.ts` (alloc/release, không trùng id), `background.ts` tạo xóa session rule trong `finally`. **Live còn manual** (cần trang hotlink thật). |

## Step 7 — RAM

- Server RSS qua 5 lượt dịch mới (en/ja/ctx-miss/hit): `1662 → 1669 → 1793 → 1793
  → 1793 MB` — tăng do model lazy-load, **plateau**, không tăng theo số request.
- Object URL: `revokeEl` gọi khi site đổi `src` và khi node bị xóa
  (`content.ts` MutationObserver); browser swap thành công nhiều lần không rò blob.
  **Chrome Task Manager nhìn tay còn manual.**

## Unit gates cuối

```text
server:   ruff check ✓  ruff format ✓  pytest -m "not slow" → 62 passed, 4 deselected
extension: npm test → 5 files / 27 tests ✓  typecheck ✓  build → 3 bundles ✓
```

## Manual còn lại (không tự động được qua CDP)

1. Load unpacked bằng tay ở `chrome://extensions` (file picker native) — script
   `--load-extension` đã thay equivalent.
2. Trang hotlink thật → kiểm chứng Referer retry + session rule cleanup.
3. Chrome Task Manager xem RAM extension khi đọc nhiều chương.
