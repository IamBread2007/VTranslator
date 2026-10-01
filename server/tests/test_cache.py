from mt.cache import StageCache, make_key, normalize_context


def test_perception_roundtrip(tmp_path):
    c = StageCache(tmp_path)
    c.put_perception("k", {"a": 1}, b"png")
    assert c.get_perception("k") == ({"a": 1}, b"png")


def test_perception_missing_png_is_miss(tmp_path):
    c = StageCache(tmp_path)
    c.put_perception("k", {"a": 1}, b"png")
    (tmp_path / "perception" / "k.inpainted.png").unlink()
    assert c.get_perception("k") is None


def test_corrupted_json_is_miss(tmp_path):
    c = StageCache(tmp_path)
    c.put_translation("t", {"1": "x"})
    (tmp_path / "translation" / "t.json").write_text("{broken", encoding="utf-8")
    assert c.get_translation("t") is None


def test_no_temp_files_left(tmp_path):
    c = StageCache(tmp_path)
    c.put_translation("t", {"1": "x"})
    assert [p.name for p in (tmp_path / "translation").iterdir()] == ["t.json"]


def test_normalize_context_strip_nfc_cap():
    lines = ["  cafe\u0301 "] + [str(i) for i in range(30)]
    out = normalize_context(lines)
    assert out[0] == "caf\u00e9" and len(out) == 20


def test_make_key_stable_and_distinct():
    assert make_key("a", 1) == make_key("a", 1) != make_key("a", 2)
