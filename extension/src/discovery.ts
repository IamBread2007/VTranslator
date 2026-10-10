// The discovery pass and coverage accounting.
// Deliberately DOM-free of chrome.* so it runs under jsdom in unit tests.

import { isMangaCandidate } from "./discover";

export type Coverage = "complete" | "progressive";

export interface ScanOptions {
  wholeDocument: boolean;
  padPx: number;
}

// Background-carried pages have no dedicated tag and carry no state attributes
// before their first translation, so the selector also matches any element whose
// inline style declares background-image — the only place a page bitmap can live
// for the paths this extension reads.
const SELECTOR = 'img, [style*="background-image"]';

/**
 * Candidates in DOM order, which is also reading order for every reader this
 * extension supports. Nothing here ranks by size or visibility: `prev_context`
 * is only correct if pages are translated in the order a person reads them.
 *
 * Note what this does NOT check: rendered size. `isVisibleCandidate` gates the
 * dispatch site, and a scan-time size filter would reject every unloaded lazy
 * image — its rect is still 0x0 — which is most of a lazy reader.
 */
export function scan(root: ParentNode, opts: ScanOptions): Element[] {
  const out: Element[] = [];
  for (const el of root.querySelectorAll(SELECTOR)) {
    if (!isMangaCandidate(el)) continue;
    if (!opts.wholeDocument) {
      // Feeds and forums: stay near the viewport. A wider pass here would reach
      // every image the user has ever scrolled past in a channel.
      const r = el.getBoundingClientRect();
      if (r.bottom < -opts.padPx || r.top > window.innerHeight + opts.padPx) continue;
    }
    out.push(el);
  }
  return out;
}

/**
 * Tracks whether every page of a chapter has been *observed*, which is not the
 * same as whether the document has been fully walked.
 *
 * The caller owns that judgement because only it knows whether its reader has a
 * notion of "end of chapter": a virtualised strip that recycles nodes cannot
 * distinguish "that was the last page" from "the next one has not mounted yet".
 * Guessing here would let a lazy reader claim a whole chapter is translated when
 * half of it has never been rendered, so completeness is asserted, never inferred.
 *
 * Not DOM-aware by design: it keys on source URLs, so a page the reader remounts
 * under a new node is still counted once.
 */
export function trackCoverage(): {
  accept(url: string): void;
  finishTraversal(): void;
  state(): Coverage;
  size(): number;
} {
  const seen = new Set<string>();
  let finished = false;
  return {
    accept(url: string): void {
      // Only a genuinely new URL reopens coverage. Rediscovery re-offers the
      // same URLs constantly, and treating that as new work would mean
      // "complete" could never persist between scans.
      if (seen.has(url)) return;
      seen.add(url);
      finished = false;
    },
    finishTraversal(): void {
      finished = true;
    },
    state(): Coverage {
      return finished ? "complete" : "progressive";
    },
    /** Distinct pages observed. This is what the HUD may present as a total. */
    size(): number {
      return seen.size;
    },
  };
}