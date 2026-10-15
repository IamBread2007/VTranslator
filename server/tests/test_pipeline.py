import asyncio
import base64
import io

import pytest
from PIL import Image

from mt.ocr import OcrResult
from mt.pipeline import ImageTooLargeError, Pipeline, UnsupportedImageError
from mt.schemas import Box, Style, TranslateOptions


class FakeDet:
    def __init__(self, items):
        self.items = items
        self.calls = 0

    def detect(self, img):
        self.calls += 1
        return self.items


class FakeOcr:
    def read(self, crop):
        return OcrResult(text="テキスト", confidence=0.9)


class FakeTr:
    def __init__(self, reply="Chữ"):
        self.calls = 0
        self.reply = reply

    def translate(self, page, items, src, tgt, prev_context, warnings=None):
        self.calls += 1
        return {items[0][0]: self.reply} if self.reply else {}


class NoopInpainter:
    def inpaint(self, page, blocks):
        return page.copy()


def fake_style(*_args, **_kwargs):
    return Style(
        color="#000000",
        stroke_color="#ffffff",
        stroke_width=0,
        font_px=20,
        font="dialogue",
    )


def default_text_items():
    return [
        (Box(x=0, y=0, w=200, h=200), "bubble", 0.9),
        (Box(x=40, y=40, w=100, h=60), "text_bubble", 0.9),
    ]


def make_pipeline(
    tmp_path,
    detector=None,
    translator=None,
    style_estimator=fake_style,
    inpainter=None,
    max_image_bytes=25 * 1024 * 1024,
    max_dimension=20000,
    max_pixels=30_000_000,
):
    return Pipeline(
        detector=detector or FakeDet(default_text_items()),
        get_ocr=lambda key: FakeOcr(),
        translator=translator or FakeTr(),
        style_estimator=style_estimator,
        inpainter=inpainter or NoopInpainter(),
        cache_dir=tmp_path,
        ocr_engine="auto",
        llm_model="m",
        perception_config={"detector": "fake"},
        max_image_bytes=max_image_bytes,
        max_dimension=max_dimension,
        max_pixels=max_pixels,
    )


def _png(size=(300, 300)):
    b = io.BytesIO()
    Image.new("RGB", size, "white").save(b, "PNG")
    return b.getvalue()


def test_no_text_skips_llm(tmp_path):
    tr = FakeTr()
    det = FakeDet([(Box(x=0, y=0, w=100, h=100), "bubble", 0.9)])
    p = make_pipeline(tmp_path, detector=det, translator=tr)
    r = p.run(_png(), TranslateOptions(source_lang="ja"))
    assert r.blocks == [] and tr.calls == 0


def test_style_is_measured_before_inpaint(tmp_path):
    seen = {}

    def style_fn(page, box, kind, line_count, mask_roi=None):
        seen["pixel"] = page.getpixel((0, 0))
        return fake_style()

    class BlackInpainter:
        def inpaint(self, page, blocks):
            return Image.new("RGB", page.size, "black")

    p = make_pipeline(tmp_path, style_estimator=style_fn, inpainter=BlackInpainter())
    p.run(_png(), TranslateOptions(source_lang="ja"))
    assert seen["pixel"] == (255, 255, 255)


def test_response_blocks_and_render_box(tmp_path):
    r = make_pipeline(tmp_path).run(_png(), TranslateOptions(source_lang="ja"))
    assert r.resolved_source_lang == "ja" and (r.width, r.height) == (300, 300)
    [b] = r.blocks
    assert (b.id, b.source, b.translation) == (1, "テキスト", "Chữ")
    # text inside bubble → bubble shrunk 12% per side
    assert b.render_box == Box(x=24, y=24, w=152, h=152)
    png = base64.b64decode(r.inpainted_png)
    assert Image.open(io.BytesIO(png)).size == (300, 300)


def test_missing_translation_falls_back_to_source(tmp_path):
    p = make_pipeline(tmp_path, translator=FakeTr(reply=""))
    r = p.run(_png(), TranslateOptions(source_lang="ja"))
    assert r.blocks[0].translation == "テキスト"
    assert "missing translation for id 1" in r.warnings


def test_same_context_hits_translation_cache(tmp_path):
    tr = FakeTr()
    p = make_pipeline(tmp_path, translator=tr)
    opts = TranslateOptions(source_lang="ja", prev_context=["A"])
    p.run(_png(), opts)
    p.run(_png(), opts)
    assert tr.calls == 1


def test_changed_context_misses_translation_only(tmp_path):
    det = FakeDet(default_text_items())
    tr = FakeTr()
    p = make_pipeline(tmp_path, detector=det, translator=tr)
    p.run(_png(), TranslateOptions(source_lang="ja", prev_context=["A"]))
    p.run(_png(), TranslateOptions(source_lang="ja", prev_context=["B"]))
    assert det.calls == 1  # perception reused
    assert tr.calls == 2  # translation invalidated


def test_changed_llm_model_misses_translation_only(tmp_path):
    # Cache keys must include the model: a different model may translate
    # differently, but perception (detect/OCR) results stay valid.
    det = FakeDet(default_text_items())
    tr = FakeTr()
    p = make_pipeline(tmp_path, detector=det, translator=tr)
    opts = TranslateOptions(source_lang="ja")
    p.run(_png(), opts)
    p.llm_model = "other-model"
    p.run(_png(), opts)
    assert det.calls == 1
    assert tr.calls == 2


def test_rejects_too_many_pixels_before_rgb_decode(tmp_path):
    p = make_pipeline(tmp_path, max_pixels=10_000)
    with pytest.raises(ImageTooLargeError):
        p.run(_png((200, 200)), TranslateOptions(source_lang="ja"))


def test_rejects_too_many_bytes(tmp_path):
    p = make_pipeline(tmp_path, max_image_bytes=10)
    with pytest.raises(ImageTooLargeError):
        p.run(_png(), TranslateOptions(source_lang="ja"))


def test_rejects_non_image(tmp_path):
    with pytest.raises(UnsupportedImageError):
        make_pipeline(tmp_path).run(b"not an image", TranslateOptions())


class FakeAsyncTr(FakeTr):
    """A translator with a cancellable async path that can be held open."""

    def __init__(self, reply="Chu", block=False):
        super().__init__(reply)
        self.block = block
        self.started = None
        self.cancelled = False

    async def translate_async(self, img, items, src, tgt, ctx, warnings=None):
        self.calls += 1
        if self.block:
            self.started = asyncio.get_event_loop().run_in_executor(None, self._never)
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                self.cancelled = True
                raise
        return {items[0][0]: self.reply} if self.reply else {}

    @staticmethod
    def _never():
        return None


def test_run_async_returns_a_response(tmp_path):
    p = make_pipeline(tmp_path)
    r = asyncio.run(p.run_async(_png(), TranslateOptions(source_lang="ja")))
    assert r.blocks


def test_run_still_works_synchronously(tmp_path):
    # The CLI and the existing tests depend on this entry point.
    p = make_pipeline(tmp_path)
    r = p.run(_png(), TranslateOptions(source_lang="ja"))
    assert r.blocks


def test_cancelling_before_the_llm_never_calls_the_translator(tmp_path):
    tr = FakeAsyncTr(block=True)
    p = make_pipeline(tmp_path, translator=tr)

    async def main():
        task = asyncio.create_task(
            p.run_async(_png(), TranslateOptions(source_lang="ja"))
        )
        await asyncio.sleep(0.5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(main())
    assert tr.cancelled is True


def test_perception_cache_survives_a_cancelled_llm_call(tmp_path):
    # Perception already ran; cancelling the LLM must keep its cache entry so a
    # retry is translation-only rather than a full re-perceive.
    tr = FakeAsyncTr(block=True)
    p = make_pipeline(tmp_path, translator=tr)

    async def first():
        task = asyncio.create_task(
            p.run_async(_png(), TranslateOptions(source_lang="ja"))
        )
        await asyncio.sleep(0.5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(first())

    tr2 = FakeAsyncTr(block=False)
    p2 = make_pipeline(tmp_path, translator=tr2)
    # Same cache dir and same inputs, so perception must come back from cache.
    asyncio.run(p2.run_async(_png(), TranslateOptions(source_lang="ja")))
    assert tr2.calls == 1


def test_no_translation_cache_entry_after_cancel(tmp_path):
    tr = FakeAsyncTr(block=True)
    p = make_pipeline(tmp_path, translator=tr)

    async def main():
        task = asyncio.create_task(
            p.run_async(_png(), TranslateOptions(source_lang="ja"))
        )
        await asyncio.sleep(0.5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(main())
    files = list((tmp_path / "translation").glob("*.json"))
    assert files == []


class FakeGlossaryTr:
    """Returns a glossary alongside translations and records the glossary it was given."""

    def __init__(self):
        self.received_glossary = None

    def translate_full(
        self, page, items, src, tgt, prev_context, warnings=None, glossary=()
    ):
        from mt.translator import TranslationResult

        self.received_glossary = list(glossary)
        gloss = [{"term": "Yuki", "translation": "Yuki", "note": "anh"}]
        return TranslationResult(translations={items[0][0]: "Chữ"}, glossary=gloss)

    def translate(
        self, page, items, src, tgt, prev_context, warnings=None, glossary=()
    ):
        return self.translate_full(
            page, items, src, tgt, prev_context, warnings, glossary
        ).translations


def test_glossary_is_returned_in_the_response(tmp_path):
    p = make_pipeline(tmp_path, translator=FakeGlossaryTr())
    resp = p.run(_png(), TranslateOptions(source_lang="ja"))
    assert [g.model_dump() for g in resp.glossary] == [
        {"term": "Yuki", "translation": "Yuki", "note": "anh"}
    ]


def test_glossary_from_previous_page_is_fed_into_next_translation(tmp_path):
    tr = FakeGlossaryTr()
    p = make_pipeline(tmp_path, translator=tr)
    first = p.run(_png(), TranslateOptions(source_lang="ja"))
    p.run(
        _png(),
        TranslateOptions(source_lang="ja", prev_context=["x"], glossary=first.glossary),
    )
    assert tr.received_glossary == first.glossary


def test_glossary_is_capped_at_thirty_before_feeding_forward(tmp_path):
    from mt.schemas import GlossaryEntry

    big = [GlossaryEntry(term=f"t{i}", translation="v", note="") for i in range(40)]
    opts = TranslateOptions(source_lang="ja", glossary=big)
    assert len(opts.glossary) == 30


def test_glossary_change_invalidates_translation_cache(tmp_path):
    tr = FakeGlossaryTr()
    p = make_pipeline(tmp_path, translator=tr)
    p.run(_png(), TranslateOptions(source_lang="ja"))
    p.run(
        _png(),
        TranslateOptions(
            source_lang="ja",
            glossary=[{"term": "A", "translation": "B", "note": ""}],
        ),
    )
    files = list((tmp_path / "translation").glob("*.json"))
    assert len(files) == 2, files
