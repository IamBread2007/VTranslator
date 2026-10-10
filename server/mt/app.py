import asyncio
import hmac
import time
from contextlib import suppress
from typing import Annotated

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Request,
    UploadFile,
)
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.middleware.cors import CORSMiddleware

from mt.config import Settings
from mt.pipeline import ImageTooLargeError, UnsupportedImageError
from mt.schemas import TranslateOptions, TranslateResponse
from mt.translator import TranslationError

READ_CHUNK = 1024 * 1024

# How often the handler checks whether the client is still there. The spike in
# tests/test_disconnect_spike.py measured the drop being noticed within one
# interval, so this bounds Stop latency rather than the work being cancelled.
DISCONNECT_POLL_S = 0.05


class ClientGone(Exception):
    """The caller vanished mid-request; nobody will read any response."""


async def _run_observing_client(
    request: Request, pipeline, data: bytes, opts: TranslateOptions
) -> TranslateResponse:
    """Run the pipeline, cancelling it if the client disconnects.

    Without this the server would keep paying for the upstream call after the
    user pressed Stop, because the only signal that anyone still wants the answer
    is the socket going away.

    A pipeline that implements `run_async` is awaited directly, so cancelling the
    task tears down the outbound LLM request. One that only has the synchronous
    `run` is pushed to a thread, where a cancel cannot kill it: the task still
    unwinds and the client is released, but the in-flight inference finishes.
    That difference is inherent to thread-bound CPU work and is not hidden.
    """
    runner = getattr(pipeline, "run_async", None)
    if runner is None:

        async def in_thread() -> TranslateResponse:
            return await run_in_threadpool(pipeline.run, data, opts)

        job: asyncio.Task[TranslateResponse] = asyncio.create_task(in_thread())
    else:
        job = asyncio.create_task(runner(data, opts))

    # A grace window before the disconnect signal is trusted. Some transports
    # report a fully consumed request body as "disconnected" the moment the
    # handler starts, which would otherwise cancel every request instantly. A
    # real user pressing Stop cannot do that in under one poll interval anyway.
    trust_disconnect_after = time.monotonic() + DISCONNECT_POLL_S
    try:
        while not job.done():
            if (
                time.monotonic() >= trust_disconnect_after
                and await request.is_disconnected()
            ):
                job.cancel()
                with suppress(asyncio.CancelledError):
                    await job
                raise ClientGone
            await asyncio.sleep(DISCONNECT_POLL_S)
        return await job
    except BaseException:
        job.cancel()
        raise


async def _read_capped(upload: UploadFile, cap: int) -> bytes:
    """Read at most `cap` bytes; never trust Content-Length."""
    buf = bytearray()
    while chunk := await upload.read(READ_CHUNK):
        buf.extend(chunk)
        if len(buf) > cap:
            raise HTTPException(status_code=413, detail=f"image exceeds {cap} bytes")
    return bytes(buf)


def create_app(settings: Settings, pipeline=None) -> FastAPI:
    app = FastAPI(title="MangaTranslater local server")
    app.state.settings = settings
    app.state.pipeline = pipeline

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"chrome-extension://.*",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    async def auth(x_mt_token: str = Header(default="")) -> None:
        if not hmac.compare_digest(x_mt_token, settings.mt_token):
            raise HTTPException(status_code=401, detail="invalid token")

    @app.get("/health")
    def health() -> dict:
        return {"ok": True}

    @app.get("/auth-check", dependencies=[Depends(auth)])
    def auth_check() -> dict:
        return {"ok": True}

    @app.post("/translate", dependencies=[Depends(auth)])
    async def translate(
        image: Annotated[UploadFile, File()],
        options: Annotated[str, Form()] = "{}",
        request: Request = None,  # type: ignore[assignment]
    ) -> TranslateResponse:
        try:
            opts = TranslateOptions.model_validate_json(options)
        except ValidationError as e:
            raise HTTPException(status_code=422, detail="invalid options") from e
        data = await _read_capped(image, settings.max_image_bytes)
        if app.state.pipeline is None:
            raise HTTPException(status_code=503, detail="pipeline not configured")
        try:
            return await _run_observing_client(request, app.state.pipeline, data, opts)
        except ClientGone:
            # Nothing can be delivered and nobody will read it. Re-raising as 499
            # keeps the outcome visible in the log rather than looking like a
            # successful translation that the client somehow ignored.
            raise HTTPException(status_code=499, detail="client disconnected")
        except ImageTooLargeError as e:
            raise HTTPException(status_code=413, detail=str(e)) from e
        except UnsupportedImageError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        except TranslationError as e:
            raise HTTPException(status_code=502, detail=str(e)[:300]) from e

    return app
