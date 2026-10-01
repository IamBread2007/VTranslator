import hmac
from typing import Annotated

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
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
    ) -> TranslateResponse:
        try:
            opts = TranslateOptions.model_validate_json(options)
        except ValidationError as e:
            raise HTTPException(status_code=422, detail="invalid options") from e
        data = await _read_capped(image, settings.max_image_bytes)
        if app.state.pipeline is None:
            raise HTTPException(status_code=503, detail="pipeline not configured")
        try:
            return await run_in_threadpool(app.state.pipeline.run, data, opts)
        except ImageTooLargeError as e:
            raise HTTPException(status_code=413, detail=str(e)) from e
        except UnsupportedImageError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        except TranslationError as e:
            raise HTTPException(status_code=502, detail=str(e)[:300]) from e

    return app
