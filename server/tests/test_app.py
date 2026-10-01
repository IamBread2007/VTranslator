import secrets

from fastapi.testclient import TestClient
from mt.app import create_app
from mt.config import Settings

TEST_TOKEN = secrets.token_hex(16)


def make_client():
    s = Settings(mt_token=TEST_TOKEN, llm_base_url="http://x", llm_api_key="k", llm_model="m")
    return TestClient(create_app(s, pipeline=None))


def test_health_no_auth():
    assert make_client().get("/health").json() == {"ok": True}


def test_auth_check_requires_token():
    c = make_client()
    assert c.get("/auth-check").status_code == 401
    assert c.get("/auth-check", headers={"X-MT-Token": TEST_TOKEN}).json() == {"ok": True}


def test_translate_requires_token():
    r = make_client().post("/translate", files={"image": ("a.png", b"x")})
    assert r.status_code == 401
