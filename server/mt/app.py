import hmac

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from starlette.middleware.cors import CORSMiddleware

from mt.config import Settings


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
    def translate() -> Response:
        return Response(
            status_code=501,
            content="pipeline not implemented yet",
            media_type="text/plain",
        )

    return app
