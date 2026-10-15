import asyncio
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


def _async_translator(handler):
    return LlmTranslator(
        "http://llm",
        "k",
        "m",
        async_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def _ok(content: str) -> dict:
    return {"choices": [{"message": {"content": content}}]}


def test_translate_async_returns_the_same_result_as_the_sync_path():
    def handler(req):
        return httpx.Response(
            200, json=_ok('{"translations":[{"id":1,"text":"dich"}]}')
        )

    async def run():
        t = _async_translator(handler)
        return await t.translate_async(
            Image.new("RGB", (50, 50)), _items("x"), "ja", "vi", []
        )

    assert asyncio.run(run()) == {1: "dich"}


def test_translate_async_retries_once_on_bad_json():
    calls = []

    def handler(req):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(200, json=_ok("not json at all"))
        return httpx.Response(
            200, json=_ok('{"translations":[{"id":1,"text":"dich"}]}')
        )

    async def run():
        t = _async_translator(handler)
        return await t.translate_async(
            Image.new("RGB", (50, 50)), _items("x"), "ja", "vi", []
        )

    assert asyncio.run(run()) == {1: "dich"}
    assert len(calls) == 2


def test_translate_async_http_error_raises_translation_error():
    async def run():
        t = _async_translator(lambda req: httpx.Response(429, json={"error": "quota"}))
        await t.translate_async(Image.new("RGB", (50, 50)), _items("x"), "ja", "vi", [])

    with pytest.raises(TranslationError, match="429"):
        asyncio.run(run())


def test_cancellation_propagates_and_is_not_turned_into_a_translation_error():
    # This is the property the whole Stop feature rests on. If CancelledError
    # were caught and re-raised as TranslationError, a cancelled request would
    # look like a failed one: the page would be marked errored and the upstream
    # call billed as if it had failed on its own merits.
    started = asyncio.Event()

    async def handler(req):
        started.set()
        await asyncio.sleep(30)  # never completes inside the test
        return httpx.Response(200, json=_ok("{}"))

    async def run():
        t = _async_translator(handler)
        task = asyncio.create_task(
            t.translate_async(Image.new("RGB", (50, 50)), _items("x"), "ja", "vi", [])
        )
        await asyncio.wait_for(started.wait(), timeout=5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())


def test_cancelling_before_the_request_starts_never_reaches_the_llm():
    calls = []

    async def handler(req):
        calls.append(1)
        return httpx.Response(200, json=_ok("{}"))

    async def run():
        t = _async_translator(handler)
        task = asyncio.create_task(
            t.translate_async(Image.new("RGB", (50, 50)), _items("x"), "ja", "vi", [])
        )
        task.cancel()  # before the coroutine ever runs
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
    assert calls == [], "a cancelled run still spent an LLM call"


def test_translate_async_returns_empty_without_calling_the_llm():
    calls = []

    async def handler(req):
        calls.append(1)
        return httpx.Response(200, json=_ok("{}"))

    async def run():
        t = _async_translator(handler)
        return await t.translate_async(Image.new("RGB", (50, 50)), [], "ja", "vi", [])

    assert asyncio.run(run()) == {}
    assert calls == []


def test_som_builds_single_annotated_image_under_edge_cap():
    from mt.translator import build_som_image

    page = Image.new("RGB", (800, 1200), "white")
    som = build_som_image(
        page, [(1, Box(x=10, y=10, w=50, h=80)), (2, Box(x=300, y=600, w=120, h=60))]
    )
    assert isinstance(som, Image.Image)
    assert max(som.size) <= 1600


def test_som_draws_red_outline_for_each_region():
    from mt.translator import build_som_image

    page = Image.new("RGB", (400, 400), "white")
    som = build_som_image(page, [(1, Box(x=50, y=50, w=100, h=100))])
    # Outline colour must appear on the box edge, not inside the empty interior.
    assert som.getpixel((50, 100))[0] > 150
    assert som.getpixel((100, 100)) == (255, 255, 255)


def test_parse_accepts_glossary_object_and_returns_translations_only():
    raw = (
        '{"translations":[{"id":1,"text":"x"}],'
        '"glossary":[{"term":"A","translation":"B","note":"anh-em"}]}'
    )
    assert parse_translations(raw, {1}) == {1: "x"}


def test_parse_glossary_is_exposed_separately():
    from mt.translator import parse_glossary

    raw = '{"translations":[],"glossary":[{"term":"A","translation":"B","note":"n"}]}'
    assert parse_glossary(raw) == [{"term": "A", "translation": "B", "note": "n"}]


def test_parse_glossary_caps_at_thirty_and_drops_malformed():
    from mt.translator import parse_glossary

    entries = [{"term": f"t{i}", "translation": "v", "note": ""} for i in range(40)]
    entries.append({"term": 5})  # malformed: non-string term
    raw = json.dumps({"translations": [], "glossary": entries})
    out = parse_glossary(raw)
    assert len(out) == 30
    assert all(isinstance(e["term"], str) for e in out)


def test_parse_glossary_missing_returns_empty():
    from mt.translator import parse_glossary

    assert parse_glossary('{"translations":[{"id":1,"text":"x"}]}') == []
    assert parse_glossary("garbage") == []


def test_vision_request_uses_som_image_for_normal_page():
    # Normal pages send one image; it must carry the outline + [n] markers.
    page = Image.new("RGB", (400, 400), "white")
    vis = build_vision_images(page, [(1, Box(x=50, y=50, w=100, h=100))])
    assert len(vis) == 1
    assert vis[0].getpixel((50, 100))[0] > 150  # red outline present


def test_vision_webtoon_still_overview_plus_tiles_with_som_markers():
    img = Image.new("RGB", (800, 10000), "white")
    blocks = [(1, Box(x=10, y=100, w=50, h=80)), (2, Box(x=20, y=9000, w=50, h=80))]
    vis = build_vision_images(img, blocks)
    assert len(vis) > 2
    assert all(max(v.size) <= 1600 for v in vis)
    assert vis[0].getpixel((10, 140))[0] > 150  # overview carries the outline


def test_translate_result_carries_glossary_separately_from_translations():
    from mt.translator import TranslationResult

    content = (
        '{"translations":[{"id":1,"text":"Xin chào"}],'
        '"glossary":[{"term":"A","translation":"B","note":"anh-em"}]}'
    )

    def h(req):
        return httpx.Response(200, json=_ok(content))

    res = _translator(h).translate_full(
        Image.new("RGB", (50, 50)), _items("こんにちは"), "ja", "vi", []
    )
    assert isinstance(res, TranslationResult)
    assert res.translations == {1: "Xin chào"}
    assert res.glossary == [{"term": "A", "translation": "B", "note": "anh-em"}]


def test_prompt_includes_glossary_context_from_previous_pages():
    imgs = [Image.new("RGB", (100, 100))]
    gloss = [{"term": "Yuki", "translation": "Yuki", "note": "em gái, gọi là em"}]
    msgs = build_messages(imgs, [(1, "x")], "ja", "vi", ["câu trước"], glossary=gloss)
    text = next(p["text"] for p in msgs[-1]["content"] if p["type"] == "text")
    assert "Yuki" in text and "em gái" in text
