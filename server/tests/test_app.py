import secrets

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
