# MangaTranslater — dịch manga/webtoon tại chỗ trên trang đọc

Chrome extension dịch chữ trong ảnh manga sang tiếng Việt: phát hiện khung thoại → OCR →
vision-LLM dịch (ảnh + text) → inpaint chữ gốc → render lại chữ Việt đúng font, đúng màu,
không tràn. Backend là server Python local trên `127.0.0.1:8765`.

## Yêu cầu

- Python 3.12 (PaddleOCR chưa hỗ trợ 3.14).
- Node 18+ (build extension).
- Chrome; GPU NVIDIA thì cài `torch==2.14.1+cu130` (xem `server/requirements.txt`).

## 1. Chạy server

```bash
cd server
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
cp .env.example .env        # rồi tự điền MT_TOKEN và LLM_MODEL
.venv/Scripts/python -m mt
```

- `MT_TOKEN`: secret dùng chung extension ↔ server — **không commit**, không chia sẻ.
  Sinh nhanh: `python -c "import secrets; print(secrets.token_urlsafe(32))"`.
- `LLM_MODEL`: model vision-LLM qua OmniRoute. Đã test ổn định:
  `agy/gemini-3.8-flash-high` (vision ~9–12s/request).
- Đổi `.env` phải **restart** server (`python -m mt` đọc lúc khởi động).
- Kiểm tra: `curl http://127.0.0.1:8765/health` → `{"ok":true}`.

## 2. Build + load extension

```bash
cd extension
npm install
npm run build     # output → extension/dist/
```

Mở `chrome://extensions` → bật Developer mode → **Load unpacked** → chọn
`extension/dist`. Sau khi sửa code: `npm run build` rồi bấm Reload icon.

## 3. Cấu hình Options

Chuột phải icon extension → Options (hoặc `chrome://extensions` → Details →
Extension options):

- **Địa chỉ server**: `http://127.0.0.1:8765`.
- **Token**: dán đúng `MT_TOKEN` (lưu vào `chrome.storage.local` — chỉ field password,
  không bao giờ đưa sang sync hay hiện lên DOM).
- Bấm **Kiểm tra kết nối** — ba trạng thái:
  - `Server local chưa chạy` — server tắt hoặc sai cổng.
  - `Server chạy nhưng token sai` — 401 từ `/auth-check`.
  - `Kết nối và token hợp lệ` — xong.

## 4. Dùng

- **Hover ảnh** → nút **Dịch** góc trên-trái → bấm để dịch từng ảnh.
- **Alt+T**: dịch toàn bộ ảnh manga trong viewport (queue tuần tự — ảnh sau chỉ gửi
  khi ảnh trước xong, kèm ngữ cảnh 20 dòng trước đó để dịch nhất quán).
- **Alt+O** (giữ): xem lại ảnh gốc.
- **Context menu → “Dịch ảnh này”**: dịch ảnh bấm chuột phải.
- **Alt+T browser command**: nếu trang nuốt hotkey, service worker tự chuyển tiếp.
- Lỗi hiển thị badge `Lỗi — bấm để thử lại` (page không vỡ); sửa lỗi rồi bấm badge
  hoặc Alt+T để thử lại.

## Lỗi thường gặp (đã gặp thật)

| Thông điệp | Nguyên nhân | Fix |
| --- | --- | --- |
| `Server local chưa chạy (python -m mt)` | server tắt / sai cổng | bật lại server |
| `Sai token — kiểm tra trong Settings` | token trong Options ≠ `MT_TOKEN` | đồng bộ lại |
| `Dịch quá thời gian 120s — thử lại` | LLM chậm/timeout | retry; hoặc đổi `LLM_MODEL` |
| `Ảnh quá lớn` | vượt `max_image_bytes` 25MB / 30MP | ảnh bị chặn trước khi decode |
| Lỗi cài `torch` (file locked) | server đang giữ `site-packages/torch` | tắt server trước khi pip |
| Paddle `NotImplementedError ... PIR` | Paddle 3.3 + MKLDNN | giữ `enable_mkldnn=False` |

## Kiểm chứng

- Server: `.venv/Scripts/pytest -q -m "not slow"` (chậm có marker `slow`).
- Extension: `cd extension && npm test && npm run typecheck && npm run build`.
- Bằng chứng E2E thật + ma trận regression: `docs/e2e-notes.md`.
- Quy tắc dự án: `pi-warden.md`.

Không sao chép code từ `zyddnys/manga-image-translator` (GPL-3.0); fixtures tự sinh,
fonts (Patrick Hand, Bangers, Be Vietnam Pro) subset Latin + Vietnamese.
