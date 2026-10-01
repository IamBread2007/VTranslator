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
}

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
 * Returns fontPx=minPx with overflow=true when even minPx does not fit.
 */
export function fitText(
  text: string,
  box: Box,
  measure: Measure,
  opts: FitOptions,
): FitResult {
  const fits = (px: number): string[] | null => {
    const lines = wrapText(text, box.w, px, measure);
    const h = lines.length * px * opts.lineHeight;
    const wOk = lines.every((l) => measure(l, px) <= box.w);
    return h <= box.h && wOk ? lines : null;
  };

  let lo = opts.minPx;
  let hi = opts.maxPx;
  let best: { px: number; lines: string[] } | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const lines = fits(mid);
    if (lines) {
      best = { px: mid, lines };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best) return { fontPx: best.px, lines: best.lines, overflow: false };
  return { fontPx: opts.minPx, lines: wrapText(text, box.w, opts.minPx, measure), overflow: true };
}
