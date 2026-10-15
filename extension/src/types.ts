// API v2 contract — must match server/mt/schemas.py field-for-field.

// Latin-script sources ("pt", "es", "id") are manual-only: the server's script
// fast-path cannot separate them from each other or from "en", so an auto
// request never resolves to them. "es" also covers Mexican Spanish.
export type SourceLang = "auto" | "ja" | "ko" | "zh" | "en" | "pt" | "es" | "id";
export type ResolvedLang = "ja" | "ko" | "zh" | "en" | "pt" | "es" | "id";
export type FontRole = "dialogue" | "shout" | "narration";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Style {
  color: string;
  stroke_color: string;
  stroke_width: number;
  font_px: number;
  font: FontRole;
}

export interface Block {
  id: number;
  box: Box;
  render_box: Box;
  kind: "text_bubble" | "text_free";
  source: string;
  translation: string;
  style: Style;
  /**
   * Measured bubble contour: width fractions (0..1 of `box.w`) sampled evenly
   * from the bubble's top to its bottom, replacing the shrink+ellipse guess.
   * Null (or absent, from an older server) means layout falls back to the
   * rectangle/ellipse shape for this block.
   */
  slice_widths?: number[] | null;
}

export interface TranslateOptions {
  source_lang: SourceLang;
  target_lang: string;
  prev_context: string[];
}

export interface TranslateResponse {
  width: number;
  height: number;
  inpainted_png: string;
  resolved_source_lang: ResolvedLang;
  blocks: Block[];
  warnings: string[];
}
