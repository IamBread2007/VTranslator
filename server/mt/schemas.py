from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

ColorStr = str  # validated with regex below


class Box(BaseModel):
    x: int
    y: int
    w: int
    h: int


class Style(BaseModel):
    color: str = Field(pattern=r"^#[0-9a-f]{6}$")
    stroke_color: str = Field(pattern=r"^#[0-9a-f]{6}$")
    stroke_width: int
    font_px: int
    font: Literal["dialogue", "shout", "narration"]


class Block(BaseModel):
    id: int
    box: Box
    render_box: Box
    kind: Literal["text_bubble", "text_free"]
    source: str
    translation: str
    style: Style
    # Measured bubble contour (12 widths, fractions of box.w). None on blocks
    # without a clean bubble, where the client keeps the rectangle/ellipse shape.
    slice_widths: list[float] | None = None


class GlossaryEntry(BaseModel):
    term: str = Field(max_length=200)
    translation: str = Field(max_length=200)
    note: str = Field(default="", max_length=200)


class TranslateOptions(BaseModel):
    # Latin-script sources ("pt", "es", "id") are manual-only: the script
    # fast-path cannot separate them from each other or from "en", so auto
    # never yields them. "es" also covers Mexican Spanish.
    source_lang: Literal["auto", "ja", "ko", "zh", "en", "pt", "es", "id"] = "auto"
    target_lang: Literal["vi"] = "vi"
    prev_context: list[str] = Field(default_factory=list, max_length=20)
    glossary: list[GlossaryEntry] = Field(default_factory=list)

    @field_validator("glossary", mode="before")
    @classmethod
    def _cap_glossary(cls, v: Any) -> Any:
        # A prior page's glossary is fed forward whole; the newest entries are the
        # ones still relevant, so cap at the same 30 the prompt builder uses.
        if isinstance(v, list) and len(v) > 30:
            return v[-30:]
        return v


class TranslateResponse(BaseModel):
    width: int
    height: int
    inpainted_png: str
    resolved_source_lang: Literal["ja", "ko", "zh", "en", "pt", "es", "id"]
    blocks: list[Block]
    warnings: list[str]
    glossary: list[GlossaryEntry] = Field(default_factory=list)
