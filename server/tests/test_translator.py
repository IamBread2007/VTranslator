import json

import httpx
import pytest
from PIL import Image

from mt.schemas import Box
from mt.translator import (
    LlmTranslator,
    TranslationError,
    build_messages,
    build_vision_images,
    parse_translations,
)


def test_parse_plain_json():
    raw = '{"translations":[{"id":1,"text":"Chào"}]}'
    assert parse_translations(raw, {1}) == {1: "Chào"}


def test_parse_fenced_json_and_ignores_unknown_ids():
    raw = (
        'Đây:\n```json\n{"translations":[{"id":1,"text":"A"},{"id":9,"text":"B"}]}\n```'
    )
    assert parse_translations(raw, {1, 2}) == {1: "A"}


def test_parse_garbage_returns_empty():
    assert parse_translations("xin lỗi tôi không thể", {1}) == {}


def test_normal_page_builds_one_vision_image():
    img = Image.new("RGB", (800, 1200), "white")
    vis = build_vision_images(img, [(1, Box(x=10, y=10, w=50, h=80))])
    assert len(vis) == 1


def test_long_webtoon_builds_overview_plus_tiles():
    img = Image.new("RGB", (800, 10000), "white")
    blocks = [(1, Box(x=10, y=100, w=50, h=80)), (2, Box(x=20, y=9000, w=50, h=80))]
    vis = build_vision_images(img, blocks)
    assert len(vis) > 2
    assert all(max(v.size) <= 1600 for v in vis)


def test_messages_contain_all_images_and_ids():
    imgs = [Image.new("RGB", (100, 100)), Image.new("RGB", (100, 100))]
    msgs = build_messages(imgs, [(1, "こんにちは")], "ja", "vi", ["câu trước"])
    user = msgs[-1]["content"]
    assert sum(p["type"] == "image_url" for p in user) == 2
    assert "1: こんにちは" in next(p["text"] for p in user if p["type"] == "text")


def _translator(handler):
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return LlmTranslator("http://llm", "k", "m", client=client)


def _items(text):
    return [(1, Box(x=0, y=0, w=20, h=20), text)]


def test_translate_success():
    content = '{"translations":[{"id":1,"text":"Xin chào"}]}'

    def h(req):
        body = json.loads(req.content)
        assert body["model"] == "m"
        return httpx.Response(
            200, json={"choices": [{"message": {"content": content}}]}
        )

    out = _translator(h).translate(
        Image.new("RGB", (50, 50)), _items("こんにちは"), "ja", "vi", []
    )
    assert out == {1: "Xin chào"}


def test_translate_retries_once_on_bad_json_then_returns_partial():
    calls = []

    def h(req):
        calls.append(1)
        return httpx.Response(200, json={"choices": [{"message": {"content": "???"}}]})

    t = _translator(h)
    assert t.translate(Image.new("RGB", (50, 50)), _items("x"), "ja", "vi", []) == {}
    assert len(calls) == 2


def test_translate_http_error_raises():
    t = _translator(lambda req: httpx.Response(429, json={"error": "quota"}))
    with pytest.raises(TranslationError, match="429"):
        t.translate(Image.new("RGB", (50, 50)), _items("x"), "ja", "vi", [])
