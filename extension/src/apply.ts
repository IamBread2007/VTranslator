// Painting a finished translation back onto an element.
//
// Bridges three pure pieces: which URL an element points at (discover), how an
// element's own source is saved and restored (imgsrc), and which pages this tab
// has already translated (store). Kept out of content.ts so the paged-reader
// path — the one that decides whether going back to page 3 costs a re-translation
// — is unit-testable rather than only reachable by hand.

import { resolveImageUrl } from "./discover";
import {
  APPLIED_BLOB,
  HIDDEN_BG,
  ORIG_BG,
  ORIG_SRC,
  ORIG_SRCSET,
  STATE,
  applyBackgroundSwap,
  reapplyTranslatedBackground,
  restoreOriginalBackground,
} from "./imgsrc";
import type { TranslationStore } from "./store";

/**
 * Paint an already-composed blob onto an element, saving whatever the site had.
 *
 * Shared by the translate path and the re-apply path so a page that comes back in
 * a paged reader is set up exactly like one translated the first time; otherwise
 * show-original and the MutationObserver's self-write guard would only know about
 * the first case.
 */
export function swapIn(el: Element, url: string, objectUrl: string): void {
  if (el instanceof HTMLImageElement) {
    el.setAttribute(ORIG_SRC, url);
    const origSrcset = el.getAttribute("srcset");
    if (origSrcset) el.setAttribute(ORIG_SRCSET, origSrcset);
    el.removeAttribute("srcset"); // lazy loaders must not override our swap
    el.removeAttribute("data-src");
    el.setAttribute(APPLIED_BLOB, objectUrl);
  }
  if (el instanceof HTMLElement && !(el instanceof HTMLImageElement)) {
    // Only the background-image property is written: the same inline style
    // carries scroll-snap and direction values the reader needs for paging.
    applyBackgroundSwap(el, objectUrl);
    el.setAttribute(APPLIED_BLOB, objectUrl);
  }
}

/**
 * Re-apply a page this tab has already translated, without a server round trip.
 *
 * This is what makes a paged reader usable: the reader unmounts the page when it
 * advances, so coming back is a brand-new element pointing at a URL the store
 * already holds. Returns whether the element was a cached page, which is also the
 * signal that it must not be queued.
 */
export function applyStored(el: Element, store: TranslationStore): boolean {
  if (el.getAttribute(STATE)) return false; // pending/done/error is not "fresh"
  const url = resolveImageUrl(el);
  if (!url) return false;
  const objectUrl = store.get(url);
  if (!objectUrl) return false;
  swapIn(el, url, objectUrl);
  el.setAttribute(STATE, "done");
  return true;
}

/**
 * Re-apply across a freshly mounted subtree, since readers add a wrapper element
 * rather than the <img> directly. Returns the elements it translated, so the
 * caller can give each one its own one-shot confirmation.
 */
export function applyStoredIn(node: Node, store: TranslationStore): Element[] {
  if (!(node instanceof Element)) return [];
  if (applyStored(node, store)) return [node];
  const out: Element[] = [];
  for (const img of node.querySelectorAll("img")) {
    if (applyStored(img, store)) out.push(img);
  }
  return out;
}

/* ---------------- hold-to-peek ---------------- */

/**
 * Swap one translated element back to the page's own source. Returns whether it
 * changed, so a repeat call while the key is still held stays a no-op instead of
 * losing what it was showing.
 *
 * Only the composed blob is on screen, so this is also the only way to compare
 * against the artwork the site served.
 */
export function showOriginal(el: Element): boolean {
  if (el.getAttribute(STATE) !== "done") return false;
  if (el instanceof HTMLImageElement) {
    const orig = el.getAttribute(ORIG_SRC);
    const blob = el.getAttribute(APPLIED_BLOB);
    if (!orig || !blob || el.getAttribute("src") === orig) return false;
    el.setAttribute("src", orig);
    // The site's responsive set is what the browser should pick the original
    // from; without it the saved src is shown at whatever size we saved.
    const srcset = el.getAttribute(ORIG_SRCSET);
    if (srcset) el.setAttribute("srcset", srcset);
    return true;
  }
  if (el instanceof HTMLElement && !el.getAttribute(HIDDEN_BG) && el.getAttribute(ORIG_BG)) {
    restoreOriginalBackground(el);
    return true;
  }
  return false;
}

/** Put the composed blob back after showOriginal. */
export function showTranslated(el: Element): boolean {
  if (el instanceof HTMLImageElement) {
    const blob = el.getAttribute(APPLIED_BLOB);
    if (!blob || el.getAttribute("src") === blob) return false;
    // A restored srcset would outrank src and keep showing the original.
    el.removeAttribute("srcset");
    el.setAttribute("src", blob);
    return true;
  }
  if (el instanceof HTMLElement && el.getAttribute(HIDDEN_BG)) {
    reapplyTranslatedBackground(el);
    return true;
  }
  return false;
}

/**
 * Hold-to-peek across every translated page under `root`: `hold` swaps them to
 * the site's own source, releasing puts the composed blobs back. Returns how
 * many elements changed, so the caller can tell "nothing was translated" from
 * "the peek happened".
 */
export function togglePeek(hold: boolean, root: ParentNode = document): number {
  let changed = 0;
  for (const el of root.querySelectorAll(`[${STATE}="done"][${APPLIED_BLOB}]`)) {
    if (hold ? showOriginal(el) : showTranslated(el)) changed++;
  }
  return changed;
}