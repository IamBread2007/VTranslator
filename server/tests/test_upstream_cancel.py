"""Proves a cancelled run really does reach the upstream provider.

The unit tests elsewhere show that a cancelled task unwinds. This one shows the
thing that actually costs money: the socket to the model provider is torn down,
the provider notices, and nothing is left behind that a later read could mistake
for a completed translation.

Everything is local. No provider credentials are used and no request leaves the
machine.
"""

from __future__ import annotations

import asyncio
import io
import json
import socket
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient
from PIL import Image

from mt.app import create_app
from mt.config import Settings
from mt.schemas import TranslateOptions
from mt.translator import LlmTranslator
from tests.test_pipeline import make_pipeline

TEST_TOKEN = "upstream-token"


class _Upstream:
    """A model provider that starts generating and then never finishes."""

    def __init__(self) -> None:
        self.disconnects = 0
        self.completed = 0
        self.requests = 0
        self._server: ThreadingHTTPServer | None = None

    @property
    def base_url(self) -> str:
        assert self._server is not None
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def _serve(self, handler_cls) -> None:
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        self._server.daemon_threads = True
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def start_stalling(self) -> None:
        up = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args) -> None:
                return

            def do_POST(self) -> None:
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                up.requests += 1
                # Headers first, so the provider has genuinely begun responding.
                # A provider that has not started is not one that was cancelled.
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", "100000")
                self.end_headers()
                try:
                    # Stream, rather than sleep silently. A provider that writes
                    # nothing cannot notice that its client has gone; one that is
                    # emitting tokens finds out on the next write. This is also
                    # the realistic shape of a cancelled generation.
                    for _ in range(2000):
                        self.wfile.write(b"x" * 256)
                        self.wfile.flush()
                        time.sleep(0.02)
                except (BrokenPipeError, ConnectionResetError, OSError):
                    up.disconnects += 1
                    return
                up.completed += 1

        self._serve(Handler)

    def start_answering(self) -> None:
        up = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args) -> None:
                return

            def do_POST(self) -> None:
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                up.requests += 1
                up.completed += 1
                payload = json.dumps(
                    {"choices": [{"message": {"content": '{"0": "Chu"}'}}]}
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self._serve(Handler)

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()


@pytest.fixture
def upstream():
    up = _Upstream()
    up.start_stalling()
    yield up
    up.stop()


def _png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (800, 1200), (240, 240, 245)).save(buf, format="PNG")
    return buf.getvalue()


def _pipeline(up: _Upstream, tmp_path):
    """A real Pipeline whose only genuine collaborator is the translator."""
    return make_pipeline(
        tmp_path,
        translator=LlmTranslator(
            up.base_url,
            "k",
            "m",
            async_client=httpx.AsyncClient(timeout=httpx.Timeout(120.0)),
        ),
    )


def _wait_for(predicate, timeout=20.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


def _start_server(app):
    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
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
    assert port is not None, "server never bound"
    return srv, thread, port


def _multipart(image: bytes) -> bytes:
    boundary = b"--B"
    return (
        boundary
        + b'\r\nContent-Disposition: form-data; name="options"\r\n\r\n'
        + b'{"source_lang":"ja"}\r\n'
        + boundary
        + b'\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n'
        + b"Content-Type: image/png\r\n\r\n"
        + image
        + b"\r\n"
        + b"--B--\r\n"
    )


def test_client_disconnect_tears_down_the_upstream_call(upstream, tmp_path):
    # This is the whole point of the cancellation work. A Stop that only unwinds a
    # local task leaves the provider generating into the void, and the user is
    # still billed for it.
    pipe = _pipeline(upstream, tmp_path)
    settings = Settings(mt_token=TEST_TOKEN, max_image_bytes=10 * 1024 * 1024)
    srv, thread, port = _start_server(create_app(settings, pipeline=pipe))

    try:
        body = _multipart(_png())
        head = (
            b"POST /translate HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            b"X-MT-Token: " + TEST_TOKEN.encode() + b"\r\n"
            b"Content-Type: multipart/form-data; boundary=B\r\n"
            b"Content-Length: " + str(len(body)).encode() + b"\r\n"
            b"Connection: close\r\n\r\n"
        )
        s = socket.create_connection(("127.0.0.1", port), timeout=10)
        s.sendall(head + body)

        assert _wait_for(lambda: upstream.requests >= 1), (
            "the run never reached the provider"
        )

        # Now behave like a user who pressed Stop.
        s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        s.close()

        assert _wait_for(lambda: upstream.disconnects >= 1, timeout=10), (
            "the provider never noticed the client leaving, so the cancelled task "
            "did not tear down the upstream request"
        )
        assert upstream.completed == 0, "the provider finished a run nobody wanted"
    finally:
        srv.should_exit = True
        thread.join(timeout=5)


def test_a_cancelled_run_leaves_no_translation_in_the_cache(upstream, tmp_path):
    pipe = _pipeline(upstream, tmp_path)

    async def run_and_cancel():
        task = asyncio.create_task(
            pipe.run_async(_png(), TranslateOptions(source_lang="ja"))
        )
        # Wait for the upstream call to exist before pulling the rug, otherwise
        # this would only be testing cancellation before any work started.
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and upstream.requests < 1:
            await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run_and_cancel())

    assert _wait_for(lambda: upstream.disconnects >= 1, timeout=10)
    translation_files = list((tmp_path / "translation").glob("*.json"))
    assert translation_files == [], (
        "a cancelled run left a translation cache entry that a later read could "
        "mistake for a completed page"
    )


def test_the_server_still_serves_after_a_cancelled_run(upstream, tmp_path):
    # Cancellation must not poison the server: the next request is an ordinary one
    # and has to succeed.
    pipe = _pipeline(upstream, tmp_path)
    settings = Settings(mt_token=TEST_TOKEN, max_image_bytes=10 * 1024 * 1024)
    client = TestClient(create_app(settings, pipeline=pipe))

    async def run_and_cancel():
        task = asyncio.create_task(
            pipe.run_async(_png(), TranslateOptions(source_lang="ja"))
        )
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and upstream.requests < 1:
            await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run_and_cancel())

    answering = _Upstream()
    answering.start_answering()
    try:
        pipe.translator = LlmTranslator(
            answering.base_url, "k", "m", async_client=httpx.AsyncClient()
        )
        resp = client.post(
            "/translate",
            files={"image": ("a.png", _png())},
            data={"options": '{"source_lang":"ja"}'},
            headers={"X-MT-Token": TEST_TOKEN},
        )
        assert resp.status_code == 200
        assert answering.completed == 1
    finally:
        answering.stop()
