// Decision for "the site changed the src of an image we already handled".
// Pure DOM module so it runs under jsdom: content.ts owns the queue, the blob
// map, and every chrome.* surface, and none of those may execute at import.
// Exported here because both the MutationObserver and its tests read the same
// attribute contract.

export const STATE = "data-mt-state";
export const ORIG_SRC = "data-mt-original-src";
export const ORIG_SRCSET = "data-mt-original-srcset";
// Background-carried pages (Pixiv paints each page as a div's background-image):
// the previous inline background-image is saved here while our composed blob is
// on screen, mirroring ORIG_SRC for the img path.
export const ORIG_BG = "data-mt-original-bg";
// Where our own background blob is stashed while the original is shown.
// Exported because the MutationObserver in content.ts must treat a style change
// during the show-original pause as ours, not as a site swap.
export const HIDDEN_BG = "data-mt-hidden-bg";

/**
 Replace a background element's page image with our composed blob.

 Only the background-image property is touched, never the style attribute as a
 whole: the same inline style carries scroll-snap-align, direction and
 scroll-snap-stop that the reader needs for paging, and rewriting the attribute
 would wipe them. The previous value is saved per property so "show original"
 can put it back.
 */
export function applyBackgroundSwap(el: HTMLElement, objectUrl: string): void {
  const prev = el.style.backgroundImage;
  if (prev) el.setAttribute(ORIG_BG, prev);
  noteOwnStyleWrite(el);
  el.style.backgroundImage = `url("${objectUrl}")`;
}

/** Show the saved original background, stashing our blob for the way back. */
export function restoreOriginalBackground(el: HTMLElement): void {
  const orig = el.getAttribute(ORIG_BG);
  if (!orig) return;
  const ours = el.style.backgroundImage;
  noteOwnStyleWrite(el);
  el.style.backgroundImage = orig;
  if (ours) el.setAttribute(HIDDEN_BG, ours);
}

/** Put our composed background blob back after "show original". */
export function reapplyTranslatedBackground(el: HTMLElement): void {
  const hidden = el.getAttribute(HIDDEN_BG);
  if (!hidden) return;
  noteOwnStyleWrite(el);
  el.style.backgroundImage = hidden;
  el.removeAttribute(HIDDEN_BG);
}

// Style mutations our own swap/show-original produced. The MutationObserver
// consumes this set before inspecting records so a site-driven background
// change is never mistaken for ours (and vice versa): bookkeeping cleared on
// our own write would break "show original" mid-hold.
let ownStyleWrites = new Set<Element>();

/** Record that el's background-image was written by this extension. */
function noteOwnStyleWrite(el: Element): void {
  ownStyleWrites.add(el);
}

/** Elements we wrote to since the last call; clears the set. */
export function takeOwnStyleWrites(): Set<Element> {
  const taken = ownStyleWrites;
  ownStyleWrites = new Set();
  return taken;
}

/**
 * Reset an image whose source the site replaced after we translated it.
 * Returns whether this record concerned the extension, so the caller can tell
 * "stale translation cleared" apart from "an image we never touched".
 *
 * It never queues work: translation starts only from an explicit user trigger,
 * otherwise a site lazy-loader swapping src would silently re-run the pipeline.
 * A pending image is left untouched because its translate request is in flight;
 * dropping it would leak the in-progress job and the blob it is about to own.
 *
 * The site's new source is what stays on screen: re-applying our saved
 * data-mt-original-src would fight the loader that just swapped it, so the
 * bookkeeping attributes are dropped and the element is left as a plain image.
 */
export function onSiteSourceSwap(
  el: HTMLElement,
  revokeBlob: (el: HTMLElement) => void,
): boolean {
  const state = el.getAttribute(STATE);
  if (state !== "done" && state !== "error") return false;
  revokeBlob(el);
  el.removeAttribute(STATE);
  el.removeAttribute(ORIG_SRC);
  el.removeAttribute(ORIG_SRCSET);
  // imgs never carry these attributes, so the removals are no-ops on the img path.
  el.removeAttribute(ORIG_BG);
  el.removeAttribute(HIDDEN_BG);
  return true;
}
