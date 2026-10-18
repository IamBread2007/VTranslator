# MangaTranslater — đọc manga/webtoon tiếng Việt ngay trên trang đọc

Tiện ích Chrome giúp bạn đọc truyện chữ Nhật/Hàn/Trung bằng tiếng Việt: chữ gốc
trong ảnh được xoá và thay bằng chữ Việt, ngay trên trang bạn đang đọc.

**Bản v1.1 làm được gì:**
- Bấm **Alt+T** dịch cả chương đang mở (có hỏi trước khi dịch nếu nhiều trang,
  vì mỗi trang tốn một lần gọi AI).
- **Di chuột vào ảnh** → nút **Dịch** để dịch từng ảnh lẻ.
- Giữ **Alt+O** (hoặc nút **Gốc**) để xem lại ảnh gốc, thả ra về bản dịch.
- Bật chế độ **Sửa** (nút **Sửa** hoặc **Alt+E**), bấm vào bong bóng thoại để
  gõ lại câu dịch sai — sửa xong hiện ngay, không tốn thêm tiền AI.
- Lật trang đi rồi quay lại vẫn giữ bản dịch, không phải dịch lại.
- Tự bỏ qua ảnh đại diện (avatar), ảnh bình luận khi đếm số trang.
- Nhớ từ riêng/tên riêng và cách xưng hô (anh/em, cậu/tớ…) suốt cả chương.
- Dùng bộ dàn chữ Rust/WebAssembly trong extension.

Gồm hai phần (bạn sẽ cài cả hai):

- **Server** chạy trên máy bạn (địa chỉ `127.0.0.1:8765`) — làm phần nặng:
  nhận diện khung thoại, đọc chữ, dịch, xoá chữ gốc.
- **Extension** Chrome — tìm ảnh trên trang, gửi cho server, hiển thị ảnh đã dịch.

> Bạn **không cần biết lập trình**. Làm đúng theo từng bước dưới đây là được.
> Hướng dẫn này viết cho **Windows**. Linux/macOS sẽ bổ sung sau.

---

## Mục lục

0. [Yêu cầu thiết bị và chuẩn bị](#0-yêu-cầu-thiết-bị-và-chuẩn-bị)
1. [Bước 1 — Tạo token (mật khẩu nội bộ)](#bước-1--tạo-token-mật-khẩu-nội-bộ)
2. [Bước 2 — Lấy API key để dịch](#bước-2--lấy-api-key-để-dịch)
3. [Bước 3 — Chạy server](#bước-3--chạy-server)
4. [Bước 4 — Cài extension vào Chrome](#bước-4--cài-extension-vào-chrome)
5. [Bước 5 — Điền cài đặt trong Options](#bước-5--điền-cài-đặt-trong-options)
6. [Bước 6 — Bắt đầu dịch](#bước-6--bắt-đầu-dịch)
7. [Cập nhật lên bản mới](#cập-nhật-lên-bản-mới)
8. [Lỗi thường gặp](#lỗi-thường-gặp)
9. [Bản quyền và ghi nhận](#bản-quyền-và-ghi-nhận)

---

## 0. Yêu cầu thiết bị và chuẩn bị

### Thiết bị tối thiểu

- **Windows 10 hoặc 11 64-bit** trên CPU x64 (Intel/AMD). PaddlePaddle không
  hỗ trợ Windows ARM64 trong cấu hình này.
- **RAM 8 GB** là mức tối thiểu; **16 GB** giúp ổn định hơn khi xử lý ảnh lớn
  hoặc mở nhiều tab truyện.
- Cần **ít nhất 8 GB trống để chạy** sau khi cài. Nếu build từ mã nguồn trên
  máy này, nên chừa **ít nhất 10 GB** để có chỗ cho Rust, Node.js, file tải về
  và file tạm. Phần chạy thực tế gồm server Python và model nhận dạng chữ/phát
  hiện bong bóng tại máy:

  | Thành phần | Dung lượng tham khảo |
  | --- | ---: |
  | Môi trường Python và thư viện OCR/AI cục bộ | khoảng 4,5 GB |
  | Model nhận dạng chữ và phát hiện bong bóng | khoảng 1,1 GB |
  | Extension Chrome đã build | dưới 1 MB |
  | Phần trống dành cho tải xuống và file tạm | khoảng 1,5 GB |

  Cache ảnh đã xử lý tại `server\.cache` có thể tăng thêm khoảng 1 GB hoặc hơn
  khi dịch nhiều chương. Model **dịch** dùng API nên không tải LLM dịch về máy.
- Kết nối Internet khi cài lần đầu, tải model OCR/phát hiện và gọi API dịch.
  Dùng GPU NVIDIA là tuỳ chọn; không có GPU vẫn chạy được nhưng chậm hơn.

### Phần mềm cần cài

- **[Python 3.12.10 64-bit](https://www.python.org/downloads/release/python-31210/)**.
  Đây là bản đã kiểm tra cho server. Không dùng Python 3.14 vì PaddlePaddle
  chưa có gói cài đặt tương thích.
  - Khi cài, tích **Add python.exe to PATH**.
  - Nếu installer có tuỳ chọn Python Launcher, hãy cài để dùng được lệnh `py`.
- **[Node.js 18 trở lên](https://nodejs.org/en/download)**. Chỉ cần khi build
  extension; bản LTS là lựa chọn phù hợp.
- **[Rust toolchain](https://rustup.rs/)**. Chỉ cần khi build extension; Rust
  biên dịch bộ dàn chữ sang WebAssembly.
- **[Google Chrome](https://www.google.com/chrome/)** để cài extension.

Tải mã nguồn về máy (**Code → Download ZIP** trên GitHub, rồi giải nén), hoặc
dùng git:

```bash
git clone <https://github.com/IamBread2007/VTranslator.git>
```

---

## Bước 1 — Tạo token (mật khẩu nội bộ)

**Token** là mật khẩu để extension và server nhận ra nhau. Chỉ dùng trên máy bạn.

1. Mở **PowerShell** trong thư mục `server` (giữ Shift + chuột phải vào thư mục
   `server` → **Open PowerShell window here**).
2. Chạy lệnh:

   ```bash
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```

3. Lệnh in ra một chuỗi ký tự dài. **Copy và giữ kín chuỗi này.**

> ⚠️ **Không** gửi token cho người khác, không đăng lên mạng, không chụp màn
> hình chia sẻ.

---

## Bước 2 — Lấy API key để dịch

Server cần một dịch vụ AI để đọc và dịch chữ. Chúng tôi khuyên dùng
**OpenRouter**: một địa chỉ để dùng nhiều model AI, trong đó có model miễn phí.

### 2.1. Tạo tài khoản

1. Vào **<https://openrouter.ai>** → **Sign Up** (Đăng ký).
2. Làm theo hướng dẫn để xác nhận email.

### 2.2. Tạo API key

1. Vào **<https://openrouter.ai/keys>**.
2. Bấm **Create Key** (Tạo key), đặt tên tuỳ ý, rồi xác nhận.
3. Copy chuỗi key vừa tạo. Key thường bắt đầu bằng `sk-or-`.

> ⚠️ Key là mật khẩu tài khoản của bạn. **Không** dán vào mã nguồn,
> **không** đưa lên GitHub, **không** chia sẻ. Nếu lỡ lộ, vào trang Keys xoá
> key đó đi rồi tạo key mới.

### 2.3. Chọn model

Model quyết định chất lượng dịch và tốc độ. Model phải **đọc được ảnh**
(vì extension gửi ảnh trang manga cho model).

- Xem danh sách tại **<https://openrouter.ai/models>** và bật bộ lọc
  **Input: Image**.
- Muốn dùng miễn phí: bật bộ lọc **Free** hoặc tìm model có đuôi **`:free`**
  (ví dụ `google/gemma-4-31b-it:free`).
- Tên model ghi đúng như trên trang chi tiết, kể cả đuôi `:free`.

> 💡 **Lưu ý về bản miễn phí:** giới hạn khoảng **50 yêu cầu/ngày** nếu chưa nạp
> tiền, khoảng **1000 yêu cầu/ngày** nếu đã nạp từ $10 (theo FAQ của OpenRouter).
> Model miễn phí có thể bị gỡ hoặc đổi — nếu báo lỗi, chọn model `:free`
> khác có hỗ trợ ảnh.

### 2.4. Các nguồn API khác (tuỳ chọn, bỏ qua cũng được)

Bạn cũng có thể dùng dịch vụ khác có API tương thích OpenAI. Khi đó đổi
`LLM_BASE_URL` và `LLM_API_KEY` tương ứng (xem file `server/.env.example`):

| Dịch vụ | Ghi chú |
| --- | --- |
| Google Gemini (AI Studio) | Có hạn mức miễn phí, xem <https://ai.google.dev/gemini-api/docs/rate-limits> |
| Groq | Base URL `https://api.groq.com/openai/v1`, kiểm tra model có hỗ trợ ảnh tại <https://console.groq.com/docs/models> |
| Ollama (chạy model ngay trên máy bạn) | Miễn phí, không cần key. Base URL `http://127.0.0.1:11434/v1`. **Lưu ý:** model phải đọc được ảnh (model chỉ-chữ như họ HY-MT/Sakura sẽ không dịch được vì server luôn gửi kèm ảnh trang truyện) |

---

## Bước 3 — Chạy server

1. Mở **PowerShell** trong thư mục `server`, rồi kiểm tra đúng Python 3.12:

   ```powershell
   cd server
   python --version
   ```

   Kết quả phải là `Python 3.12.x`. Nếu `python` đang trỏ tới bản khác hoặc
   không chạy, dùng đường dẫn mặc định của Python 3.12.10:

   ```powershell
   & "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" -m venv .venv
   ```

   Nếu `python --version` đã là 3.12.x, tạo môi trường bằng:

   ```powershell
   python -m venv .venv
   ```

   > Nếu đã có thư mục `.venv` tạo bằng Python 3.14 hoặc phiên bản khác, dừng
   > server, xoá **riêng** thư mục `.venv`, rồi mới tạo lại bằng Python 3.12.
   > Không xoá `server\.env` vì file đó chứa cấu hình riêng.

   Cài thư viện vào đúng môi trường vừa tạo:

   ```powershell
   .\.venv\Scripts\python.exe -m pip install --timeout 120 --retries 10 -r requirements.txt
   ```

   Lần đầu có thể mất nhiều phút vì phải tải PyTorch, PaddleOCR và model phụ thuộc.
   Không dừng cửa sổ nếu pip vẫn đang tải dữ liệu. Lần dịch đầu tiên cũng có thể
   chậm hơn vì server tải model OCR và phát hiện bong bóng về máy khi cần.

2. Tạo file cấu hình từ mẫu:

   ```bash
   copy .env.example .env
   ```

3. Mở file `server\.env` bằng Notepad và điền:

   ```text
   MT_TOKEN=<token bạn tạo ở Bước 1>
   LLM_BASE_URL=https://openrouter.ai/api/v1
   LLM_API_KEY=<API key bạn lấy ở Bước 2>
   LLM_MODEL=<tên model bạn chọn ở Bước 2.3>
   ```

   Ví dụ (chỗ này chỉ minh hoạ, **không** phải key thật):
   `LLM_MODEL=google/gemma-4-31b-it:free`

   > File `server\.env` chứa bí mật của bạn, đã được chặn đưa lên GitHub.
   > **Đừng** copy nó đi nơi khác để chia sẻ.

4. Chạy server:

   ```bash
   .venv\Scripts\python -m mt
   ```

   Để cửa sổ này mở trong lúc dùng.

5. Kiểm tra: mở trình duyệt, vào <http://127.0.0.1:8765/health>.
   Nếu hiện `{"ok":true}` là được.

> Đổi nội dung `.env` thì phải **tắt và chạy lại** server.

---

## Bước 4 — Cài extension vào Chrome

1. Build extension (chạy trong thư mục `extension`). Cài Node.js và Rust
   toolchain ở Bước 0 trước.

   ```powershell
   cd extension
   npm install
   cargo install wasm-pack --locked
   npm run build
   ```

   `npm run build` tự biên dịch bộ dàn chữ Rust thành WebAssembly rồi tạo
   `extension\dist`. Đây là thư mục bạn cần cài.

2. Mở Chrome, gõ vào thanh địa chỉ: `chrome://extensions`
3. Bật công tắc **Developer mode** (Chế độ nhà phát triển) ở góc trên bên phải.
4. Bấm **Load unpacked** (Tải tiện ích đã giải nén).
5. Chọn thư mục **`extension\dist`** → bấm **Select Folder**.
6. Thấy tiện ích **Manga Translator** hiện ra là cài xong.

---

## Bước 5 — Điền cài đặt trong Options

1. Chuột phải biểu tượng extension trên thanh Chrome → **Options**.
   (Hoặc: `chrome://extensions` → **Details** → **Extension options**.)
2. Điền:
   - **URL server local**: `http://127.0.0.1:8765`
   - **Token**: dán đúng token ở Bước 1.
   - **Ngôn ngữ nguồn**: để **Tự động nhận diện** (Nhật/Hàn/Trung/Anh),
     hoặc chọn tay nếu trang nào đó nhận diện sai.
3. **Giới hạn khi dịch cả chương** (để không bị tốn tiền oan):
   - **Số trang dịch trước khi hỏi** (mặc định 10): dịch tới đây sẽ hiện hộp
     hỏi có dịch tiếp không.
   - **Số trang tối đa mỗi lần**: trần cứng cho một lần Alt+T.
4. **Cách đọc của từng trang** (quan trọng với trang truyện):
   - Mặc định (`auto`) Alt+T chỉ dịch ảnh gần màn hình — đủ cho Facebook,
     chat, diễn đàn.
   - Với trang đọc truyện, thêm host (ví dụ `mangadex.org`) và chọn cách đọc:
     `vertical-scroll` (cuộn dọc một dải dài), `paged` (lật từng trang như
     sách), `horizontal-slide` (trượt ngang). Khai báo đúng thì Alt+T mới
     gom đủ trang của cả chương.
5. Bấm **Kiểm tra kết nối**. Kết quả có thể là:
   - `Server local chưa chạy` → quay lại Bước 3, bật server.
   - `Server chạy nhưng token sai` → kiểm tra token có khớp `MT_TOKEN` không.
   - `Kết nối và token hợp lệ` → xong. Bấm **Lưu**.

---

## Bước 6 — Bắt đầu dịch

Mở một trang manga/webtoon bạn muốn đọc, rồi dùng một trong các cách sau:

- **Di chuột vào ảnh** → bấm nút **Dịch** ở góc trên-trái ảnh để dịch từng ảnh.
- **Alt + T**: dịch tất cả ảnh manga đang hiện trên màn hình. Ảnh được dịch
  lần lượt, lấy ngữ cảnh các trang trước để câu dịch nhất quán. Nếu nhiều
  trang, extension sẽ hỏi trước khi dịch tiếp.
- **Alt + S**: dừng lô dịch đang chạy.
- **Giữ Alt + O** (hoặc nút **Gốc** trên thanh công cụ): xem ảnh gốc
  (chưa dịch). Thả ra để xem lại bản dịch.
- **Sửa** (hoặc **Alt + E**): bật chế độ sửa, bấm vào bong bóng thoại để gõ
  lại câu dịch sai. Sửa xong hiện ngay, không tốn thêm tiền AI.
- **Chuột phải vào ảnh → "Dịch ảnh này"**.

Nếu một ảnh báo lỗi (badge `Lỗi — bấm để thử lại`), kiểm tra server đang chạy
rồi bấm badge đó để thử lại. Trang vẫn đọc bình thường.

**Mẹo đọc truyện dài:** với truyện lật từng trang (kiểu MangaDex, Comix),
cứ Alt+T ở mỗi trang khi đọc tới — trang đã dịch được giữ lại, không mất
tiền dịch lại khi quay lại.

---

## Cập nhật lên bản mới

Khi có bản mới (ví dụ từ v1.0 lên v1.1), làm theo thứ tự này — thiếu bước nào
là bản mới không có hiệu lực:

1. Tải code mới về (git pull hoặc tải ZIP mới), đè lên thư mục cũ
   (giữ lại file `server\.env` của bạn — đừng xoá, đừng ghi đè).
2. Nếu bản mới ghi "cần cài thêm thư viện": chạy lại
   `.venv\Scripts\pip install -r requirements.txt` trong thư mục `server`.
3. **Tắt server cũ, chạy lại server** (bước này ai cũng quên):
   `.venv\Scripts\python -m mt`
4. Trong thư mục `extension`, chạy lại `npm run build`. Lệnh này tự biên dịch
   lại phần Rust/WebAssembly trước khi đóng gói extension.
5. Vào `chrome://extensions` → bấm nút **Reload** (vòng tròn) của tiện ích.
6. **F5 (tải lại) các tab truyện đang mở** — tab cũ vẫn chạy code cũ cho tới
   khi tải lại trang.

---

## Lỗi thường gặp

| Thông báo | Nguyên nhân | Cách xử lý |
| --- | --- | --- |
| `Server local chưa chạy` | Server đã tắt hoặc sai cổng | Chạy lại `python -m mt` trong thư mục `server` |
| `Sai token` / `token sai` | Token trong Options không khớp `MT_TOKEN` | Dán lại đúng token, bấm Lưu |
| `Dịch quá thời gian` | Model chậm hoặc quá tải | Thử lại; hoặc đổi sang model khác trong `LLM_MODEL` |
| `LLM HTTP 401` trong log server | API key sai hoặc chưa điền | Kiểm tra `LLM_API_KEY` trong `server\.env`, khởi động lại server |
| `LLM HTTP 429` | Vượt giới hạn yêu cầu miễn phí | Đợi hết ngày, nạp credit, hoặc chọn model khác |
| `Ảnh quá lớn` | Ảnh vượt 25 MB hoặc 30 megapixel | Ảnh bị chặn trước khi xử lý, không mất tiền |
| Alt+T đếm nhiều hơn số trang truyện | Đếm cả avatar/ảnh bình luận | Từ v1.0 extension đã tự bỏ qua avatar và ảnh trong khung bình luận. Nếu vẫn thấy, thử F5 tải lại trang rồi Alt+T lại |
| Alt+T báo xong nhưng vài trang trắng trơn | Trang đó chưa tải xong khi bấm | Lật tới trang đó cho ảnh hiện ra rồi Alt+T lại |
| Lỗi cài `torch` (file bị khoá) | Server đang chạy và giữ thư viện | Tắt server trước khi cài |
| `No matching distribution found for paddlepaddle` | Đang tạo `.venv` bằng Python 3.14 hoặc bản không được hỗ trợ | Cài Python 3.12.10, xoá riêng thư mục `.venv`, rồi tạo lại bằng Python 3.12 theo Bước 3 |
| `py` không được nhận diện | Python Launcher chưa được cài hoặc chưa vào PATH | Dùng lệnh đầy đủ `& "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" -m venv .venv` ở Bước 3 |
| Trang Cloudflare bắt xác minh | Trang truyện chống bot | Mở trang bằng Chrome thường, bấm xác minh một lần rồi hãy dịch |
| Dùng model local Ollama mà không dịch được | Model chỉ-chữ (không đọc ảnh) | Server luôn gửi kèm ảnh trang truyện, model chỉ-chữ sẽ timeout. Hãy dùng model đọc được ảnh, hoặc hỏi người rành để bật chế độ chỉ-chữ |

---

## Bản quyền và ghi nhận

- Mã nguồn của dự án này được phát hành theo giấy phép **MIT** — xem file [`LICENSE`](LICENSE).
- Dự án tham khảo thiết kế của [zyddnys/manga-image-translator](https://github.com/zyddnys/manga-image-translator) (GPL-3.0) nhưng **không sao chép mã nguồn** từ dự án đó.
- Phông chữ đi kèm (Patrick Hand, Bangers, Be Vietnam Pro) theo giấy phép **SIL Open Font License 1.1** — xem `extension/fonts/OFL.txt`.
- Các model AI và thư viện bên thứ ba (ví dụ model phát hiện khung thoại của ogkalu, manga-ocr, PaddleOCR) có giấy phép riêng. Kiểm tra giấy phép của từng phần khi bạn tái phân phối.
