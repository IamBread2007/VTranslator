// Keep one implementation: the Rust core owns layout behavior.
// Named imports keep the async glue out of Chrome's classic content script; its
// `import.meta.url` default path would make the injected script fail to parse.
import {
  capsFromSliceWidths as capsFromSliceWidthsCore,
  fitText as fitTextCore,
  inkRatio,
  initSync,
  lineCaps as lineCapsCore,
  widthAt as widthAtCore,
  wrapText as wrapTextCore,
  wrapTextCaps as wrapTextCapsCore,
} from "../core/pkg/mt_layout.js";

export type Measure = (text: string, fontPx: number) => number;

export interface Box {
  w: number;
  h: number;
  /**
   * Server-measured bubble contour: width fractions of `w`, sampled evenly from
   * the box's top edge to its bottom edge. Missing or null means the server had
   * no clean outline to measure, so the rectangle/ellipse fallback stays in use.
   */
  slice_widths?: number[] | null;
}

/**
 * Shape of the usable area inside `Box`.
 *
 * "rect" is the whole box and reproduces the pre-ellipse behaviour. "ellipse"
 * models a round/oval speech balloon: the box is the balloon's *bounding* box,
 * so its corners are outline rather than usable space, and text wrapped to the
 * full width spills over the balloon edge.
 */
export type Shape = "rect" | "ellipse";

export interface FitOptions {
  minPx: number;
  maxPx: number;
  lineHeight: number;
  /** Defaults to "rect", which keeps older callers bit-for-bit unchanged. */
  shape?: Shape;
}

export interface FitResult {
  fontPx: number;
  lines: string[];
  overflow: boolean;
  /** Line height actually used for `lines`; may be tighter than requested. */
  lineHeight: number;
}

/**
 * Fraction of the line box occupied by glyph ink. Leading belongs between
 * baselines and ascender/descender space carries no ink, so only the ink band
 * has to clear the balloon outline — measuring the full line height would
 * under-estimate the room available on the middle lines of a round balloon.
 * Exported so tests can verify the geometry independently of the fitter.
 */
export const INK_RATIO = 0.72;

/** Thrown by every forwarder when the wasm instance is not available. */
const WASM_ERROR = "layout wasm failed to load";

let ready = false;
let loading: Promise<void> | null = null;

/**
 * Path the manifest serves the wasm from. A content script is a classic
 * script, so `import.meta` is a syntax error there; the runtime URL is the only
 * portable way to name a packaged file.
 */
function wasmUrl(): string {
  return chrome.runtime.getURL("layout.wasm");
}

/**
 * Instantiate the core once. Load is shared between concurrent callers, and a
 * failed load is not cached, so a transient fetch failure can be retried.
 *
 * The bytes go through `initSync` rather than the glue's async `init`: that
 * function falls back to `new URL(..., import.meta.url)`, which is a syntax
 * error inside a manifest content script. Fetching the packaged URL ourselves
 * keeps `import.meta` out of the bundle entirely.
 */
export async function ensureLayoutWasm(): Promise<void> {
  if (ready) return;
  loading ??= (async () => {
    const bytes = await (await fetch(wasmUrl())).arrayBuffer();
    initSync({ module: bytes });
  })();
  try {
    await loading;
    ready = true;
  } catch (cause) {
    loading = null;
    throw new Error(WASM_ERROR, { cause });
  }
}

/**
 * wasm-bindgen leaves every export throwing until its instance is set. Probing
 * once with the cheapest export tells "not loaded yet" (vitest pre-initializes
 * the same module in tests/setup.ts) apart from a real call failing later.
 */
function layout(): void {
  if (!ready) {
    try {
      inkRatio();
    } catch (cause) {
      throw new Error(WASM_ERROR, { cause });
    }
    ready = true;
  }
}

function slicesJson(box: Box): string {
  return JSON.stringify(box.slice_widths ?? null);
}

/**
 * Caps for a per-line profile. The crate takes the caps as an array, and a line
 * always consumes at least one character, so sampling one cap per character
 * covers every line the wrapper can produce.
 */
function profileCaps(profile: (lineIndex: number) => number, text: string): Float64Array {
  const caps = new Float64Array(text.length);
  for (let i = 0; i < caps.length; i++) caps[i] = profile(i);
  return caps;
}

export type MaxWidth = number | ((lineIndex: number) => number);

/** Split into lines so every line measures <= its cap at fontPx. */
export function wrapText(
  text: string,
  maxWidth: MaxWidth,
  fontPx: number,
  measure: Measure,
): string[] {
  layout();
  if (typeof maxWidth === "number") return wrapTextCore(text, maxWidth, fontPx, measure);
  return wrapTextCapsCore(text, profileCaps(maxWidth, text), fontPx, measure);
}

/**
 * Width in px available at fractional height `t` of `box` (0 = top edge, 1 =
 * bottom edge).
 *
 * A `slice_widths` profile holds samples spread evenly over the box height, so
 * the two samples bracketing `t` are lerped; without a profile the whole box
 * width is available, reproducing the pre-contour rectangle.
 */
export function widthAt(box: Box, t: number): number {
  layout();
  return widthAtCore(box.w, box.h, slicesJson(box), t);
}

/**
 * Per-line width caps from a measured contour, sampled at each line's vertical
 * centre — where `renderPage` centres the line when it draws it. Absent
 * profile: rectangle caps, so a server that never sends the field renders
 * exactly as before.
 */
export function capsFromSliceWidths(box: Box, lineCount: number): number[] {
  layout();
  return Array.from(capsFromSliceWidthsCore(box.w, box.h, slicesJson(box), lineCount));
}

/**
 * Usable width for each of `lineCount` lines, measured across the ink band that
 * actually carries glyphs.
 *
 * A measured `slice_widths` contour is preferred to either shape: it is the
 * bubble's own outline, not an idealisation of it. The shapes still serve
 * blocks (and older servers) that have no profile.
 *
 * For "rect" every line gets the full box width. For "ellipse" each line gets
 * the chord of the inscribed ellipse at whichever edge of its ink band is
 * furthest from the vertical centre — the narrowest point the line has to pass
 * through. Sampling the band's centre instead would still spill at the first
 * and last lines of the block, which is the whole failure being fixed.
 *
 * Exported so tests can assert the profile's shape and that fitText honours it,
 * rather than re-deriving the geometry and asserting against a second guess.
 */
export function lineCaps(
  box: Box,
  shape: Shape,
  lineCount: number,
  fontPx: number,
  lineHeight: number,
): number[] {
  layout();
  return Array.from(
    lineCapsCore(box.w, box.h, slicesJson(box), shape, lineCount, fontPx, lineHeight),
  );
}

/**
 * Largest integer fontPx in [minPx, maxPx] whose wrapped lines fit the box.
 * Compression order when nothing fits: tighten the line height down to 1.0
 * (Vietnamese diacritics still need leading), then shrink fontPx to the
 * absolute floor of 8px; overflow=true only when even that cannot fit.
 */
export function fitText(text: string, box: Box, measure: Measure, opts: FitOptions): FitResult {
  layout();
  // The crate floors at 8 too, but the caller must not hand the search a lower
  // minPx, and a maxPx below the floor leaves no valid size to pick.
  const minPx = Math.max(opts.minPx, 8);
  if (box.w <= 0 || box.h <= 0 || opts.maxPx < 8) {
    return { fontPx: minPx, lines: [text], overflow: true, lineHeight: opts.lineHeight };
  }
  const raw: FitResult = fitTextCore(
    text,
    box.w,
    box.h,
    slicesJson(box),
    measure,
    minPx,
    opts.maxPx,
    opts.lineHeight,
    opts.shape ?? "rect",
  );
  return {
    fontPx: raw.fontPx,
    lines: raw.lines,
    overflow: raw.overflow,
    lineHeight: raw.lineHeight,
  };
}