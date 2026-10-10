import asyncio
import secrets
import socket
import struct
import threading
import time

import httpx
import uvicorn
from fastapi.testclient import TestClient

from mt.app import create_app
from mt.config import Settings
from mt.pipeline import ImageTooLargeError, UnsupportedImageError
from mt.schemas import TranslateResponse
from mt.translator import TranslationError

TEST_TOKEN = secrets.token_hex(16)


def make_client(pipeline=None, **overrides):
    s = Settings(
        mt_token=TEST_TOKEN,
        llm_base_url="http://x",
        llm_api_key="k",
        llm_model="m",
        **overrides,
    )
    return TestClient(create_app(s, pipeline=pipeline))


AUTH = {"X-MT-Token": TEST_TOKEN}


class FakePipeline:
    def __init__(self, exc=None):
        self.exc = exc
        self.opts = None

    def run(self, image_bytes, opts):
        self.opts = opts
        if self.exc:
            raise self.exc
        return TranslateResponse(
            width=1,
            height=1,
            inpainted_png="",
            resolved_source_lang="ja",
            blocks=[],
            warnings=[],
        )


def _post(c, image=b"img", options='{"source_lang":"ja"}', headers=AUTH):
    return c.post(
        "/translate",
        files={"image": ("a.png", image)},
        data={"options": options},
        headers=headers,
    )


def test_translate_ok_with_fake_pipeline():
    p = FakePipeline()
    r = _post(make_client(p))
    assert r.status_code == 200 and r.json()["resolved_source_lang"] == "ja"
    assert p.opts is not None and p.opts.source_lang == "ja"


def test_translate_wrong_token_401():
    r = _post(make_client(FakePipeline()), headers={"X-MT-Token": "nope"})
    assert r.status_code == 401


def test_translate_llm_error_502():
    p = FakePipeline(TranslationError("LLM HTTP 429: quota"))
    r = _post(make_client(p))
    assert r.status_code == 502 and "429" in r.text


def test_translate_invalid_image_400():
    r = _post(make_client(FakePipeline(UnsupportedImageError("bad"))))
    assert r.status_code == 400


def test_translate_oversize_pipeline_413():
    r = _post(make_client(FakePipeline(ImageTooLargeError("big"))))
    assert r.status_code == 413


def test_translate_upload_cap_413_without_running_pipeline():
    p = FakePipeline()
    r = _post(make_client(p, max_image_bytes=4), image=b"0123456789")
    assert r.status_code == 413 and p.opts is None


def test_translate_bad_options_422():
    c = make_client(FakePipeline())
    assert _post(c, options='{"source_lang":"xx"}').status_code == 422
    assert _post(c, options="{broken").status_code == 422


def test_translate_accepts_explicit_brazilian_portuguese():
    # pt is manual-only: it must be a valid explicit request even though the
    # script fast-path can never resolve to it.
    p = FakePipeline()
    r = _post(make_client(p), options='{"source_lang":"pt"}')
    assert r.status_code == 200
    assert p.opts is not None and p.opts.source_lang == "pt"


def test_health_no_auth():
    assert make_client().get("/health").json() == {"ok": True}


def test_auth_check_requires_token():
    c = make_client()
    assert c.get("/auth-check").status_code == 401
    assert c.get("/auth-check", headers={"X-MT-Token": TEST_TOKEN}).json() == {
        "ok": True
    }


def test_translate_requires_token():
    r = make_client().post("/translate", files={"image": ("a.png", b"x")})
    assert r.status_code == 401


def test_schema_roundtrip():
    from mt.schemas import Block, Box, Style, TranslateResponse

    b = Block(
        id=1,
        box=Box(x=0, y=0, w=10, h=10),
        render_box=Box(x=0, y=0, w=10, h=10),
        kind="text_bubble",
        source="こんにちは",
        translation="Xin chào",
        style=Style(
            color="#000000",
            stroke_color="#ffffff",
            stroke_width=0,
            font_px=20,
            font="dialogue",
        ),
    )
    r = TranslateResponse(
        width=10,
        height=10,
        inpainted_png="",
        resolved_source_lang="ja",
        blocks=[b],
        warnings=[],
    )
    assert TranslateResponse.model_validate_json(r.model_dump_json()) == r


class BlockingAsyncPipeline:
    """A pipeline with a cancellable async path that can be held open."""

    def __init__(self) -> None:
        self.cancelled = False
        self.finished = False
        self._started = threading.Event()

    def run(self, image_bytes, opts):  # pragma: no cover - async path is used
        raise AssertionError("the async path should have been preferred")

    async def run_async(self, image_bytes, opts):
        self._started.set()
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        self.finished = True
        return TranslateResponse(
            width=1,
            height=1,
            inpainted_png="",
            resolved_source_lang="ja",
            blocks=[],
            warnings=[],
        )

    def started(self):
        return self._started.wait(10)


def _start_server(pipeline):
    s = Settings(
        mt_token=TEST_TOKEN,
        max_image_bytes=10 * 1024 * 1024,
    )
    config = uvicorn.Config(
        create_app(s, pipeline=pipeline), host="127.0.0.1", port=0, log_level="warning"
    )
    srv = uvicorn.Server(config)
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    port = None
    while time.monotonic() < deadline:
        sockets = getattr(srv, "servers", None) or []
        if sockets:
            port = sockets[0].sockets[0].getsockname()[1]
            break
        time.sleep(0.05)
    assert port is not None
    return srv, thread, port


def test_disconnect_cancels_the_pipeline_over_a_real_socket():
    # The end-to-end proof: a client that vanishes mid-request must tear the
    # pipeline down instead of letting it run to completion. TestClient cannot
    # express this, so it needs a real server and a real RST.
    p = BlockingAsyncPipeline()
    srv, thread, port = _start_server(p)
    try:
        boundary = b"--X\r\n"
        body = (
            boundary
            + b'Content-Disposition: form-data; name="options"\r\n\r\n'
            + b'{"source_lang":"ja"}\r\n'
            + boundary
            + b'Content-Disposition: form-data; name="image"; filename="a.png"\r\n'
            + b"Content-Type: image/png\r\n\r\n"
            + b"img"
            + b"\r\n"
            + b"--X--\r\n"
        )
        head = (
            b"POST /translate HTTP/1.1\r\n"
            b"Host: 127.0.0.1\r\n"
            b"X-MT-Token: " + TEST_TOKEN.encode() + b"\r\n"
            b"Content-Type: multipart/form-data; boundary=X\r\n"
            + b"Content-Length: "
            + str(len(body)).encode()
            + b"\r\n"
            + b"Connection: close\r\n\r\n"
        )
        s = socket.create_connection(("127.0.0.1", port), timeout=10)
        s.sendall(head + body)
        assert p.started(), "pipeline never started"

        s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        s.close()

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not p.cancelled:
            time.sleep(0.05)
        assert p.cancelled, "the pipeline kept running after the client vanished"
        assert not p.finished
    finally:
        srv.should_exit = True
        thread.join(timeout=5)


def test_a_client_that_waits_still_gets_its_answer():
    p = FakePipeline()
    srv, thread, port = _start_server(p)
    try:
        r = httpx.post(
            f"http://127.0.0.1:{port}/translate",
            files={"image": ("a.png", b"img")},
            data={"options": '{"source_lang":"ja"}'},
            headers={"X-MT-Token": TEST_TOKEN},
            timeout=15,
        )
        assert r.status_code == 200
        assert r.json()["resolved_source_lang"] == "ja"
    finally:
        srv.should_exit = True
        thread.join(timeout=5)
