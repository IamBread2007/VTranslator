"""Spike: is an aborted client connection observable while a handler awaits?

The chapter Stop feature can only cancel the upstream LLM request if the server
notices the client went away. FastAPI exposes `Request.is_disconnected()`, but
whether it becomes true under uvicorn on this platform, while the handler is
suspended in an `await`, is a property of the stack rather than of this app.

This test answers it empirically with a real socket, a real uvicorn server and a
real abrupt close (RST). It is not a mock, because a mock would assert whatever
the code was written to believe.

If this fails, the Stop design must not depend on disconnect detection.
"""

from __future__ import annotations

import socket
import struct
import threading
import time

import pytest
import uvicorn
from fastapi import FastAPI, Request

DISCONNECT_POLL_S = 0.05
HANDLER_TIMEOUT_S = 8.0


class _Probe:
    """Shared state between the ASGI handler and the test thread."""

    def __init__(self) -> None:
        self.started = threading.Event()
        self.disconnected = threading.Event()
        self.polls = 0
        self.ever_true = False
        self.started_at = 0.0
        self.detected_at = 0.0


def _build_app(probe: _Probe) -> FastAPI:
    app = FastAPI()

    @app.get("/slow")
    async def slow(request: Request) -> dict:
        probe.started_at = time.monotonic()
        probe.started.set()
        deadline = time.monotonic() + HANDLER_TIMEOUT_S
        while time.monotonic() < deadline:
            probe.polls += 1
            if await request.is_disconnected():
                probe.ever_true = True
                probe.detected_at = time.monotonic()
                probe.disconnected.set()
                return {"disconnected": True}
            await __import__("asyncio").sleep(DISCONNECT_POLL_S)
        return {"disconnected": False}

    return app


@pytest.fixture
def server():
    probe = _Probe()
    config = uvicorn.Config(
        _build_app(probe), host="127.0.0.1", port=0, log_level="warning"
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
    assert port is not None, "uvicorn did not bind a port"
    try:
        yield port, probe
    finally:
        srv.should_exit = True
        thread.join(timeout=5)


def _hard_reset(port: int) -> None:
    """Send a request, then drop the connection with a TCP RST."""
    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    s.sendall(
        b"GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n"
    )
    # SO_LINGER with a zero timeout makes close() emit RST rather than FIN,
    # which is the harder case for the server to observe.
    s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
    s.close()


def test_aborted_client_is_observed_while_the_handler_awaits(server):
    """The spike's whole purpose: does a real disconnect reach the handler?"""
    port, probe = server

    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    s.sendall(b"GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
    assert probe.started.wait(5), "handler never started"

    # The request is in flight and the handler is polling; now vanish.
    s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
    s.close()

    observed = probe.disconnected.wait(3)
    assert probe.polls > 1, "handler never polled, so the probe proves nothing"
    assert observed, (
        "uvicorn did not report the dropped connection within 3s "
        f"after {probe.polls} polls: disconnect cannot be used as the Stop signal"
    )
    assert probe.ever_true


def test_a_client_that_stays_connected_is_not_reported_as_gone(server):
    """The other half: a live connection must not look like a disconnect."""
    port, probe = server

    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    s.sendall(b"GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
    assert probe.started.wait(5)
    # Hold the socket open for well over several poll intervals.
    time.sleep(DISCONNECT_POLL_S * 8)
    assert not probe.disconnected.is_set(), (
        "a connection that is still open was reported as disconnected; "
        "the poll would cancel every request immediately"
    )
    assert probe.polls > 4, "handler stopped polling, so the check proves nothing"
    s.close()


def test_detection_is_prompt_enough_to_poll(server):
    """Records how quickly the drop is seen, which sizes the poll interval."""
    port, probe = server

    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    s.sendall(b"GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
    assert probe.started.wait(5)
    time.sleep(0.2)
    closed_at = time.monotonic()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
    s.close()

    assert probe.disconnected.wait(3)
    latency = probe.detected_at - closed_at
    print(
        f"\ndisconnect detected {latency * 1000:.0f}ms after close (poll {DISCONNECT_POLL_S * 1000:.0f}ms)"
    )
    # Anything slower than a second would make Stop feel broken to the user.
    assert latency < 1.0, f"disconnect took {latency:.3f}s to observe"
