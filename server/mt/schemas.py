from typing import Literal

from pydantic import BaseModel, Field

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


class TranslateOptions(BaseModel):
    # Latin-script sources ("pt", "es", "id") are manual-only: the script
    # fast-path cannot separate them from each other or from "en", so auto
    # never yields them. "es" also covers Mexican Spanish.
    source_lang: Literal["auto", "ja", "ko", "zh", "en", "pt", "es", "id"] = "auto"
    target_lang: Literal["vi"] = "vi"
    prev_context: list[str] = Field(default_factory=list, max_length=20)


class TranslateResponse(BaseModel):
    width: int
    height: int
    inpainted_png: str
    resolved_source_lang: Literal["ja", "ko", "zh", "en", "pt", "es", "id"]
    blocks: list[Block]
    warnings: list[str]
