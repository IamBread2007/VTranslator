// Pure text layout: no DOM, no chrome APIs (testable in vitest).

export type Measure = (text: string, fontPx: number) => number;

export interface Box {
  w: number;
  h: number;
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

// Absolute readability floor: below 8px Vietnamese diacritics turn to mush,
// so fontPx never shrinks past it even when nothing else fits.
const ABS_MIN_PX = 8;
const LH_STEP = 0.05;

/** Hard cap on candidate line counts, so a pathological box cannot stall. */
const MAX_LINES = 64;

/**
 * Fraction of the line box occupied by glyph ink. Leading belongs between
 * baselines and ascender/descender space carries no ink, so only the ink band
 * has to clear the balloon outline — measuring the full line height would
 * under-estimate the room available on the middle lines of a round balloon.
 * Exported so tests can verify the geometry independently of the fitter.
 */
export const INK_RATIO = 0.72;

/**
 * Badness of one completely empty line; it scales as (1 - fill)^3, the familiar
 * typographic curve where a nearly-full line is almost free and an almost empty
 * one is very expensive.
 */
const BASE_BADNESS = 1000;

/**
 * Cost of bringing one more line into existence.
 *
 * Without it the total is minimised by using *as many lines as possible* — each
 * extra line shrinks the slack on every other line — which yields one-word
 * lines. This is the badness a new line must save before it pays for itself.
 */
const LINE_PENALTY = 60;

/**
 * How many line counts beyond the first feasible one are still explored.
 *
 * Badness falls as lines get shorter and LINE_PENALTY pushes back, so the
 * optimum sits at or just above the smallest count that can hold the text.
 * Testing a couple of neighbours keeps the result while skipping the long tail
 * of larger counts that the partitioner would otherwise grind through.
 */
const LOOKAHEAD_LINES = 2;

/**
 * How far above the size binary search found the linear probe continues.
 *
 * The gap between the true maximum and what binary search reports is bounded by
 * the width of one character, so a few sizes is normally enough; the cap only
 * exists so a degenerate box cannot turn the search into a full linear sweep.
 */
const MONOTONIC_PROBE_PX = 24;

/**
 * Characters allowed to hang past the end of a line. Trailing punctuation is
 * narrow, and hanging it reads better than forcing a break that leaves the
 * preceding line visibly short. Covers the brief's set (., , ! ? … : ;) plus
 * closing quotes: once the break happens *after* a trailing mark, the mark is
 * already detached from what follows, so hanging it detaches nothing — it only
 * spares a break that would shorten the preceding line for one glyph's width.
 */
const HANGING = new Set([".", ",", "!", "?", "\u2026", ":", ";", "\u201d", "\u2019"]);

/**
 * Per-line width budget: a fixed number, or a profile sampled with the index
 * of the line being filled so a caller can narrow later lines (e.g. an
 * ellipse's lower chord) without pre-computing caps.
 */
export type MaxWidth = number | ((lineIndex: number) => number);

/** Split into lines so every line measures <= its cap at fontPx. */
export function wrapText(
  text: string,
  maxWidth: MaxWidth,
  fontPx: number,
  measure: Measure,
): string[] {
  // The number form reduces to a constant profile, so both share one code path
  // and the legacy behaviour cannot drift.
  const cap = (lineIndex: number): number =>
    typeof maxWidth === "number" ? maxWidth : maxWidth(lineIndex);
  const lines: string[] = [];
  // NFC first: combining marks must count as one glyph for measuring.
  const words = text.normalize("NFC").split(/\s+/).filter(Boolean);
  let cur = "";
  for (const word of words) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (measure(candidate, fontPx) <= cap(lines.length)) {
      cur = candidate;
      continue;
    }
    if (cur) {
      lines.push(cur);
      cur = "";
    }
    if (measure(word, fontPx) <= cap(lines.length)) {
      cur = word;
      continue;
    }
    // Word alone exceeds the line: cut it by characters.
    let chunk = "";
    for (const ch of word) {
      if (measure(chunk + ch, fontPx) <= cap(lines.length)) {
        chunk += ch;
      } else {
        if (chunk) lines.push(chunk);
        chunk = ch;
      }
    }
    cur = chunk;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/** Split one over-long token into pieces that each measure <= maxWidth. */
function chunkToken(
  token: string,
  maxWidth: number,
  fontPx: number,
  measure: Measure,
): string[] {
  const pieces: string[] = [];
  let chunk = "";
  for (const ch of token) {
    if (chunk && measure(chunk + ch, fontPx) > maxWidth) {
      pieces.push(chunk);
      chunk = ch;
    } else {
      chunk += ch;
    }
  }
  if (chunk) pieces.push(chunk);
  return pieces;
}

/** NFC-normalised word tokens; combining marks must count as one glyph. */
function tokenize(text: string): string[] {
  return text.normalize("NFC").split(/\s+/).filter(Boolean);
}

/**
 * Width a line has to reserve inside the balloon. One trailing punctuation mark
 * may hang into the outline, so a line that only overflows because of its final
 * `.`, `?` or `,` still counts as fitting.
 *
 * Only a single character hangs: a run like `?!` or `...` would otherwise be
 * excluded from the measurement wholesale, and the line would overflow by the
 * full width of that run.
 */
function reservedWidth(line: string, fontPx: number, measure: Measure): number {
  const last = line.at(-1);
  if (line.length < 2 || last === undefined || !HANGING.has(last)) {
    return measure(line, fontPx);
  }
  const kept = line.slice(0, -1);
  // A line made of nothing but punctuation cannot hang: it would vanish.
  if (!kept.trim()) return measure(line, fontPx);
  return measure(kept, fontPx);
}

/**
 * Usable width for each of `lineCount` lines, measured across the ink band that
 * actually carries glyphs.
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
  if (shape !== "ellipse") return new Array<number>(lineCount).fill(box.w);

  const a = box.w / 2;
  const b = box.h / 2;
  const lineH = fontPx * lineHeight;
  const inkH = Math.min(fontPx * INK_RATIO, lineH);
  // composePage centres the block vertically inside the render box, so the
  // profiles have to be sampled around that same origin.
  const originY = (box.h - lineCount * lineH) / 2;

  const caps: number[] = [];
  for (let i = 0; i < lineCount; i++) {
    const inkTop = originY + i * lineH + (lineH - inkH) / 2;
    const inkBottom = inkTop + inkH;
    const dy = Math.max(Math.abs(inkTop - b), Math.abs(inkBottom - b));
    const ratio = Math.min(dy / b, 1);
    caps.push(2 * a * Math.sqrt(Math.max(0, 1 - ratio * ratio)));
  }
  return caps;
}

interface WrapCandidate {
  lines: string[];
  cost: number;
}

/**
 * One text unit of a line: the unit plus the separator that follows it when
 * another unit joins the same line.
 *
 * The separator is not always a space. Cutting an over-long word by characters
 * produces several pieces of a *single* word, and rejoining those with spaces
 * would both invent whitespace the source never had and inflate the measured
 * width, which in turn makes the fitter reject line counts that do fit.
 */
interface Piece {
  text: string;
  sep: string;
}

/**
 * Partition `pieces` into exactly `caps.length` lines so no line reserves more
 * than its cap, minimising total badness.
 *
 * A greedy pass cannot do this: it fills each line to the brim and strands the
 * leftover on the last line. Choosing the cheapest partition instead makes the
 * lines even, which is what a balloon needs. Returns null when the pieces
 * cannot be spread over that many lines.
 */
function balancedWrap(
  pieces: Piece[],
  caps: number[],
  fontPx: number,
  measure: Measure,
): WrapCandidate | null {
  const n = caps.length;
  const m = pieces.length;
  if (n === 0 || m === 0) return null;
  // Every line needs at least one piece, and no line may sit empty.
  if (m < n) return null;

  const INF = Number.POSITIVE_INFINITY;
  // cost[j] = cheapest total for the first j pieces on the lines placed so far.
  let prev = new Float64Array(m + 1).fill(INF);
  prev[0] = 0;
  // starts[k][j] = index of the first piece of line k+1 in the optimal prefix.
  const starts: Int32Array[] = [];

  for (let i = 1; i <= n; i++) {
    const cap = caps[i - 1];
    const cur = new Float64Array(m + 1).fill(INF);
    const start = new Int32Array(m + 1).fill(-1);
    for (let j = 1; j <= m; j++) {
      // Line i would cover pieces [a, j); grow it backwards until it overflows.
      let text = "";
      for (let a = j - 1; a >= 0; a--) {
        const piece = pieces[a];
        text = text ? `${piece.text}${piece.sep}${text}` : piece.text;
        const w = reservedWidth(text, fontPx, measure);
        if (w > cap) break;
        const base = prev[a];
        if (base === INF) continue;
        const fill = Math.min(w / cap, 1);
        const cost = base + BASE_BADNESS * (1 - fill) ** 3 + LINE_PENALTY;
        if (cost < cur[j]) {
          cur[j] = cost;
          start[j] = a;
        }
      }
    }
    starts.push(start);
    prev = cur;
  }

  if (prev[m] === INF) return null;

  const lines = new Array<string>(n);
  let j = m;
  for (let i = n; i >= 1; i--) {
    const a = starts[i - 1][j];
    let line = "";
    for (let k = a; k < j; k++) {
      line = line ? `${line}${pieces[k].sep}${pieces[k].text}` : pieces[k].text;
    }
    lines[i - 1] = line;
    j = a;
  }
  return { lines, cost: prev[m] };
}

/**
 * Best line break for one (fontPx, lineHeight) pair, or null when the text
 * cannot be placed at that size.
 *
 * Every feasible line count is tried because the width profile depends on it:
 * spreading the text over more lines makes each line shorter and therefore more
 * likely to clear the balloon's narrowing top and bottom.
 */
function bestWrap(
  text: string,
  box: Box,
  shape: Shape,
  fontPx: number,
  lineHeight: number,
  measure: Measure,
): WrapCandidate | null {
  const lineH = fontPx * lineHeight;
  // Even a single line has to fit vertically.
  if (lineH > box.h) return null;

  const words = tokenize(text);
  if (!words.length) return { lines: [""], cost: 0 };

  // A word wider than the widest possible cap can never be placed, so cut it by
  // characters the same way wrapText does rather than reporting the whole
  // block unfit. The pieces of one word rejoin with no separator; only a word
  // boundary contributes a space.
  const pieces: Piece[] = [];
  for (const word of words) {
    const parts =
      measure(word, fontPx) <= box.w ? [word] : chunkToken(word, box.w, fontPx, measure);
    parts.forEach((part, index) => {
      pieces.push({ text: part, sep: index === parts.length - 1 ? " " : "" });
    });
  }

  const maxLines = Math.min(
    MAX_LINES,
    Math.max(1, Math.floor(box.h / lineH)),
    pieces.length,
  );

  // Smallest total width any partition can occupy at a given line count. Every
  // piece is paid for, and so is every separator — except that a line break
  // *removes* the separator it breaks at, so a partition with n lines keeps
  // (total separators - the n-1 it breaks at). The cheapest arrangement breaks
  // at the widest separators, so subtracting the n-1 largest is the true
  // minimum. Each line can also hang its own final mark, so up to n hangers can
  // come off the total. Every term is chosen to make the result as small as the
  // rules allow, so this is a genuine lower bound: if it exceeds the room
  // available, no partition at n lines can fit and the partitioner is skipped,
  // and it never skips a line count the partitioner could have used.
  let piecesWidth = 0;
  const breakables: number[] = [];
  const hangers: number[] = [];
  for (let k = 0; k < pieces.length; k++) {
    const piece = pieces[k];
    piecesWidth += measure(piece.text, fontPx);
    // The final piece's separator is never rendered: nothing follows it.
    if (k < pieces.length - 1) breakables.push(measure(piece.sep, fontPx));
    // A line may only hang a mark that is actually there to hang, and a line of
    // punctuation alone cannot vanish, so it needs a character before the mark.
    const mark = piece.text.at(-1);
    if (piece.text.length > 1 && mark !== undefined && HANGING.has(mark)) {
      hangers.push(measure(mark, fontPx));
    }
  }
  let totalSep = 0;
  for (const w of breakables) totalSep += w;
  breakables.sort((a, b) => b - a);
  hangers.sort((a, b) => b - a);
  const prefix = (values: number[]): number[] => {
    const out = [0];
    for (let k = 0; k < values.length; k++) out.push(out[k] + values[k]);
    return out;
  };
  // width freed by breaking at the k widest separators, and by hanging on the k
  // widest marks.
  const removedPrefix = prefix(breakables);
  const hangPrefix = prefix(hangers);
  const roomFor = (n: number): number =>
    piecesWidth +
    totalSep -
    removedPrefix[Math.min(n - 1, breakables.length)] -
    hangPrefix[Math.min(n, hangers.length)];

  let best: WrapCandidate | null = null;
  let bestN = 0;
  for (let n = 1; n <= maxLines; n++) {
    const caps = lineCaps(box, shape, n, fontPx, lineHeight);
    let room = 0;
    for (const cap of caps) room += cap;
    if (roomFor(n) > room) continue;
    if (best && n > bestN + LOOKAHEAD_LINES) break;

    const candidate = balancedWrap(pieces, caps, fontPx, measure);
    if (candidate && (!best || candidate.cost < best.cost)) {
      best = candidate;
      bestN = n;
    }
  }
  return best;
}

/**
 * Largest integer fontPx in [minPx, maxPx] whose wrapped lines fit the box.
 * Compression order when nothing fits: tighten the line height down to 1.0
 * (Vietnamese diacritics still need leading), then shrink fontPx to the
 * absolute floor of 8px; overflow=true only when even that cannot fit.
 */
export function fitText(
  text: string,
  box: Box,
  measure: Measure,
  opts: FitOptions,
): FitResult {
  const shape = opts.shape ?? "rect";

  const search = (minPx: number, maxPx: number, lh: number): FitResult | null => {
    let lo = minPx;
    let hi = maxPx;
    let best: { px: number; lines: string[] } | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const found = bestWrap(text, box, shape, mid, lh, measure);
      if (found) {
        best = { px: mid, lines: found.lines };
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (!best) return null;

    // Feasibility is not monotone in font size: a token too wide for the box is
    // cut by characters, and a larger size cuts it into different pieces, so a
    // size above the one found can fit while an intermediate size does not.
    // Sizes also differ in how many vertical bands they need, which changes the
    // caps in the ellipse case. Binary search can therefore stop below the true
    // maximum, so probe upward past it.
    const ceiling = Math.min(maxPx, best.px + MONOTONIC_PROBE_PX);
    for (let px = best.px + 1; px <= ceiling; px++) {
      const found = bestWrap(text, box, shape, px, lh, measure);
      if (found) best = { px, lines: found.lines };
    }
    return { fontPx: best.px, lines: best.lines, overflow: false, lineHeight: lh };
  };

  // Ladder of line heights: the caller's value first (unchanged behaviour
  // when it fits), then tighter by 0.05 steps with a hard floor of 1.0 —
  // Vietnamese diacritics need leading, so never tighten below it.
  const ladder: number[] = [opts.lineHeight];
  while (ladder[ladder.length - 1] > 1.0) {
    const next = Math.max(1.0, Math.round((ladder[ladder.length - 1] - LH_STEP) * 100) / 100);
    ladder.push(next);
  }

  for (const lh of ladder) {
    const hit = search(opts.minPx, opts.maxPx, lh);
    if (hit) return hit;
  }

  // Nothing fits at minPx even at the tightest line height: shrink below
  // minPx down to the absolute floor, keeping that tightened line height.
  const tightened = ladder[ladder.length - 1];
  if (opts.minPx - 1 >= ABS_MIN_PX) {
    const hit = search(ABS_MIN_PX, opts.minPx - 1, tightened);
    if (hit) return hit;
  }

  // Genuinely impossible: report at minPx so the caller still draws the
  // hinted size, and flag overflow so it can be logged.
  return {
    fontPx: opts.minPx,
    lines: wrapText(text, box.w, opts.minPx, measure),
    overflow: true,
    lineHeight: opts.lineHeight,
  };
}
