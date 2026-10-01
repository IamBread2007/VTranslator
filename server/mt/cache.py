import hashlib
import json
import os
import tempfile
import unicodedata
from collections.abc import Sequence
from pathlib import Path

MAX_CONTEXT_LINES = 20


def normalize_context(lines: Sequence[str]) -> list[str]:
    """Strip + NFC, keep at most MAX_CONTEXT_LINES non-empty lines."""
    out = [unicodedata.normalize("NFC", s.strip()) for s in lines]
    return [s for s in out if s][:MAX_CONTEXT_LINES]


def make_key(*parts: object) -> str:
    raw = json.dumps(parts, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


class StageCache:
    """perception/<key>.json + <key>.inpainted.png, translation/<key>.json."""

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self._perception = self.root / "perception"
        self._translation = self.root / "translation"

    def get_perception(self, key: str) -> tuple[dict, bytes] | None:
        meta = _read_json(self._perception / f"{key}.json")
        if meta is None:
            return None
        try:
            png = (self._perception / f"{key}.inpainted.png").read_bytes()
        except OSError:
            return None
        return meta, png

    def put_perception(self, key: str, meta: dict, png: bytes) -> None:
        # PNG first: a JSON without its PNG is a miss, never a half result.
        _atomic_write(self._perception / f"{key}.inpainted.png", png)
        _atomic_write(
            self._perception / f"{key}.json",
            json.dumps(meta, ensure_ascii=False).encode("utf-8"),
        )

    def get_translation(self, key: str) -> dict | None:
        return _read_json(self._translation / f"{key}.json")

    def put_translation(self, key: str, data: dict) -> None:
        _atomic_write(
            self._translation / f"{key}.json",
            json.dumps(data, ensure_ascii=False).encode("utf-8"),
        )
