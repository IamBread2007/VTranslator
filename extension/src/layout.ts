// Pure text layout: no DOM, no chrome APIs (testable in vitest).

export type Measure = (text: string, fontPx: number) => number;

export interface Box {
  w: number;
  h: number;
}

export interface FitOptions {
  minPx: number;
  maxPx: number;
  lineHeight: number;
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

/** Split into lines so every line measures <= maxWidth at fontPx. */
export function wrapText(
  text: string,
  maxWidth: number,
  fontPx: number,
  measure: Measure,
): string[] {
  const lines: string[] = [];
  // NFC first: combining marks must count as one glyph for measuring.
  const words = text.normalize("NFC").split(/\s+/).filter(Boolean);
  let cur = "";
  for (const word of words) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (measure(candidate, fontPx) <= maxWidth) {
      cur = candidate;
      continue;
    }
    if (cur) {
      lines.push(cur);
      cur = "";
    }
    if (measure(word, fontPx) <= maxWidth) {
      cur = word;
      continue;
    }
    // Word alone exceeds the line: cut it by characters.
    let chunk = "";
    for (const ch of word) {
      if (measure(chunk + ch, fontPx) <= maxWidth) {
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
  const fits = (px: number, lh: number): string[] | null => {
    const lines = wrapText(text, box.w, px, measure);
    const h = lines.length * px * lh;
    const wOk = lines.every((l) => measure(l, px) <= box.w);
    return h <= box.h && wOk ? lines : null;
  };

  const search = (minPx: number, maxPx: number, lh: number): FitResult | null => {
    let lo = minPx;
    let hi = maxPx;
    let best: { px: number; lines: string[] } | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const lines = fits(mid, lh);
      if (lines) {
        best = { px: mid, lines };
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best ? { fontPx: best.px, lines: best.lines, overflow: false, lineHeight: lh } : null;
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
