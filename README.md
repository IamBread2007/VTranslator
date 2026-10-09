# MangaTranslater — dịch manga/webtoon tiếng Việt ngay trên trang đọc

Tiện ích Chrome giúp bạn đọc manga/webtoon bằng tiếng Việt: chữ Nhật/Hàn/Trung trong ảnh
được xoá và thay bằng chữ Việt, ngay trên trang bạn đang đọc.

Gồm hai phần:

- **Server** chạy trên máy bạn (địa chỉ `127.0.0.1:8765`) — làm phần nặng: nhận diện khung thoại, đọc chữ, dịch, xoá chữ gốc.
- **Extension** Chrome — tìm ảnh trên trang, gửi cho server, nhận ảnh đã dịch và hiển thị.

> Bạn **không cần biết lập trình** để dùng. Làm theo đúng thứ tự các bước dưới đây là được.

---

## Mục lục

0. [Chuẩn bị](#0-chuẩn-bị)
1. [Bước 1 — Tạo token (mật khẩu nội bộ)](#bước-1--tạo-token-mật-khẩu-nội-bộ)
2. [Bước 2 — Lấy API key từ OpenRouter](#bước-2--lấy-api-key-từ-openrouter)
3. [Bước 3 — Chạy server](#bước-3--chạy-server)
4. [Bước 4 — Cài extension vào Chrome](#bước-4--cài-extension-vào-chrome)
5. [Bước 5 — Điền cài đặt trong Options](#bước-5--điền-cài-đặt-trong-options)
6. [Bước 6 — Bắt đầu dịch](#bước-6--bắt-đầu-dịch)
7. [Lỗi thường gặp](#lỗi-thường-gặp)
8. [Bản quyền và ghi nhận](#bản-quyền-và-ghi-nhận)

---

## 0. Chuẩn bị

Cài sẵn các phần mềm sau:

- **Python 3.12** — tải từ python.org. (PaddleOCR chưa chạy trên Python 3.14.)
- **Node.js 18 trở lên** — tải từ nodejs.org. Dùng để đóng gói extension.
- **Google Chrome**.
- Máy có GPU NVIDIA: có thể cài bản `torch` có CUDA (xem `server/requirements.txt`). Không có GPU vẫn chạy được, chỉ chậm hơn.

Tải mã nguồn về máy (nút **Code → Download ZIP** trên GitHub, rồi giải nén), hoặc dùng git:

```bash
git clone <https://github.com/IamBread2007/VTranslator.git>
```

---

## Bước 1 — Tạo token (mật khẩu nội bộ)

**Token** là mật khẩu để extension và server nhận ra nhau. Chỉ dùng trên máy bạn.

1. Mở **PowerShell** hoặc **Terminal** trong thư mục `server`.
2. Chạy lệnh:

   ```bash
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```

3. Lệnh in ra một chuỗi ký tự dài, ví dụ `Xk3...` (chuỗi của bạn sẽ khác). **Copy và giữ kín chuỗi này.**

> ⚠️ **Không** gửi token cho người khác, không đăng lên GitHub, không chụp màn hình để chia sẻ.

---

## Bước 2 — Lấy API key từ OpenRouter

Server cần một model AI để đọc và dịch chữ. Chúng tôi khuyên dùng **OpenRouter**: một dịch vụ cho phép dùng nhiều model AI qua một địa chỉ duy nhất, và có sẵn các model miễn phí.

### 2.1. Tạo tài khoản

1. Vào **<https://openrouter.ai>** → chọn **Sign Up** (Đăng ký) hoặc **Sign In**.
2. Làm theo hướng dẫn để xác nhận email. Giao diện có thể thay đổi theo thời gian, nếu khác thì tìm nút đăng ký trên trang chủ.

### 2.2. Tạo API key

1. Vào **<https://openrouter.ai/keys>**.
2. Bấm **Create Key** (Tạo key), đặt tên tuỳ ý, rồi xác nhận.
3. Copy chuỗi key vừa tạo. Key thường bắt đầu bằng `sk-or-`.

> ⚠️ Key là mật khẩu tài khoản của bạn. **Không** dán vào mã nguồn, **không** đưa lên GitHub, **không** chia sẻ. Nếu lỡ lộ, vào trang Keys và xoá key đó đi, rồi tạo key mới.

### 2.3. Chọn model

Model quyết định chất lượng dịch và tốc độ. Model phải **đọc được ảnh** (hỗ trợ "image input") vì extension gửi ảnh trang manga cho model.

- Xem danh sách model tại **<https://openrouter.ai/models>** và bật bộ lọc **Input: Image** (đầu vào là ảnh).
- Muốn dùng miễn phí: bật bộ lọc **Free** hoặc tìm model có đuôi **`:free`** (ví dụ `google/gemma-4-31b-it:free`).
- Tên model ghi đúng như trên trang chi tiết của model, kể cả đuôi `:free`.

> 💡 **Lời khuyên:** Model miễn phí của OpenRouter đủ để thử nghiệm. Tuy nhiên:
> - Miễn phí có giới hạn: khoảng **50 yêu cầu/ngày** nếu tài khoản chưa nạp credit. Nạp ít nhất $10 credit thì giới hạn lên khoảng **1000 yêu cầu/ngày** (theo [FAQ của OpenRouter](https://openrouter.ai/docs/faq)).
> - Model miễn phí có thể bị gỡ hoặc đổi. Nếu lỗi, chọn model `:free` khác có ảnh.
> - Một số nhà cung cấp của model miễn phí có thể dùng dữ liệu bạn gửi để huấn luyện. Nếu bạn dịch manga riêng tư, vào **Settings → Privacy** trên OpenRouter và tắt tùy chọn cho phép nhà cung cấp huấn luyện trên dữ liệu, hoặc chọn model trả phí. Xem thêm [Provider Logging](https://openrouter.ai/docs/guides/privacy/provider-logging).

### 2.4. Các nguồn API khác (tuỳ chọn)

Bạn cũng có thể dùng dịch vụ khác có API tương thích OpenAI. Khi đó đổi `LLM_BASE_URL` và `LLM_API_KEY` tương ứng:

| Dịch vụ | Tài liệu chính thức | Ghi chú |
| --- | --- | --- |
| Google Gemini (AI Studio) | <https://ai.google.dev/gemini-api/docs/rate-limits> | Có giới hạn yêu cầu miễn phí, xem trang này để biết hạn mức hiện tại. |
| Groq | <https://console.groq.com/docs/openai> | Tương thích OpenAI, base URL `https://api.groq.com/openai/v1`. Kiểm tra model có hỗ trợ ảnh tại <https://console.groq.com/docs/models>. |
| Ollama (chạy model ngay trên máy bạn) | <https://docs.ollama.com/api/openai-compatibility> | Miễn phí, không cần key, nhưng cần máy đủ mạnh. Base URL `http://127.0.0.1:11434/v1`. |

---

## Bước 3 — Chạy server

1. Mở **PowerShell** trong thư mục `server`:

   ```bash
   cd server
   python -m venv .venv
   .venv\Scripts\pip install -r requirements.txt
   ```

2. Tạo file cấu hình từ mẫu:

   ```bash
   copy .env.example .env
   ```

3. Mở file `server\.env` bằng Notepad (hoặc bất kỳ trình soạn thảo nào) và điền:

   ```text
   MT_TOKEN=<token bạn tạo ở Bước 1>
   LLM_BASE_URL=https://openrouter.ai/api/v1
   LLM_API_KEY=<API key bạn lấy ở Bước 2>
   LLM_MODEL=<tên model bạn chọn ở Bước 2.3>
   ```

   Ví dụ (đây chỉ là chỗ minh hoạ, **không** phải key thật):
   `LLM_MODEL=google/gemma-4-31b-it:free`

   > `server\.env` chứa bí mật của bạn. File này đã được `.gitignore` chặn, không tự động đưa lên GitHub. **Đừng** sao chép nó ra chỗ khác để chia sẻ.

4. Chạy server:

   ```bash
   .venv\Scripts\python -m mt
   ```

   Để cửa sổ này mở trong lúc dùng.

5. Kiểm tra server đang chạy: mở trình duyệt, vào <http://127.0.0.1:8765/health>. Nếu hiện `{"ok":true}` là được.

> Đổi nội dung `.env` thì phải **tắt và chạy lại** server.

---

## Bước 4 — Cài extension vào Chrome

1. Build extension (chạy trong thư mục `extension`):

   ```bash
   cd extension
   npm install
   npm run build
   ```

   Sau bước này có thư mục `extension\dist`. Đây là thư mục bạn cần cài vào Chrome.

2. Mở Chrome, gõ vào thanh địa chỉ: `chrome://extensions`
3. Bật công tắc **Developer mode** (Chế độ nhà phát triển) ở góc trên bên phải.
4. Bấm **Load unpacked** (Tải tiện ích đã giải nén).
5. Chọn thư mục **`extension\dist`** → bấm **Select Folder**.
6. Thấy tiện ích **Manga Translator** hiện ra là đã cài xong.

Sau này sửa code: chạy lại `npm run build`, rồi bấm biểu tượng **Reload** (vòng tròn) của tiện ích trong `chrome://extensions`.

---

## Bước 5 — Điền cài đặt trong Options

1. Chuột phải biểu tượng extension trên thanh Chrome → **Options**.
   (Hoặc: `chrome://extensions` → **Details** → **Extension options**.)

2. Điền:
   - **Địa chỉ server**: `http://127.0.0.1:8765`
   - **Token**: dán đúng token ở Bước 1.
3. Bấm **Kiểm tra kết nối**. Kết quả có thể là:
   - `Server local chưa chạy` → quay lại Bước 3, bật server.
   - `Server chạy nhưng token sai` → kiểm tra lại token có khớp với `MT_TOKEN` không.
   - `Kết nối và token hợp lệ` → xong.

---

## Bước 6 — Bắt đầu dịch

Mở một trang manga/webtoon bạn muốn đọc, rồi dùng một trong các cách sau:

- **Di chuột vào ảnh** → bấm nút **Dịch** ở góc trên-trái ảnh để dịch từng ảnh.
- **Alt + T**: dịch tất cả ảnh manga đang hiện trên màn hình. Ảnh được dịch lần lượt, lấy ngữ cảnh các trang trước để câu dịch nhất quán.
- **Giữ Alt + O**: xem ảnh gốc (chưa dịch). Thả ra để xem lại bản dịch.
- **Chuột phải vào ảnh → "Dịch ảnh này"**.

Nếu một ảnh báo lỗi (badge `Lỗi — bấm để thử lại`), kiểm tra server đang chạy rồi bấm badge đó để thử lại. Trang vẫn đọc bình thường.

---

## Lỗi thường gặp

| Thông báo | Nguyên nhân | Cách xử lý |
| --- | --- | --- |
| `Server local chưa chạy` | Server đã tắt hoặc sai cổng | Chạy lại `python -m mt` trong thư mục `server` |
| `Sai token` | Token trong Options không khớp `MT_TOKEN` | Dán lại đúng token |
| `Dịch quá thời gian` | Model chậm hoặc quá tải | Thử lại; hoặc đổi sang model khác trong `LLM_MODEL` |
| `LLM HTTP 401` trong log server | API key sai hoặc chưa điền | Kiểm tra `LLM_API_KEY` trong `server\.env`, rồi khởi động lại server |
| `LLM HTTP 429` | Đã vượt giới hạn yêu cầu miễn phí | Đợi hết ngày, hoặc nạp credit, hoặc chọn model khác |
| `Ảnh quá lớn` | Ảnh vượt 25 MB hoặc 30 megapixel | Ảnh bị chặn trước khi xử lý |
| Lỗi cài `torch` (file bị khoá) | Server đang chạy và giữ thư viện | Tắt server trước khi cài |

---

## Bản quyền và ghi nhận

- Mã nguồn của dự án này được phát hành theo giấy phép **MIT** — xem file [`LICENSE`](LICENSE).
- Dự án tham khảo thiết kế của [zyddnys/manga-image-translator](https://github.com/zyddnys/manga-image-translator) (GPL-3.0) nhưng **không sao chép mã nguồn** từ dự án đó.
- Phông chữ đi kèm (Patrick Hand, Bangers, Be Vietnam Pro) theo giấy phép **SIL Open Font License 1.1** — xem `extension/fonts/OFL.txt`.
- Các model AI và thư viện bên thứ ba (ví dụ model phát hiện khung thoại của ogkalu, manga-ocr, PaddleOCR) có giấy phép riêng. Kiểm tra giấy phép của từng phần khi bạn tái phân phối.
