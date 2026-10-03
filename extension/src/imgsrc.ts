// Decision for "the site changed the src of an image we already handled".
// Pure DOM module so it runs under jsdom: content.ts owns the queue, the blob
// map, and every chrome.* surface, and none of those may execute at import.
// Exported here because both the MutationObserver and its tests read the same
// attribute contract.

export const STATE = "data-mt-state";
export const ORIG_SRC = "data-mt-original-src";
export const ORIG_SRCSET = "data-mt-original-srcset";

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
  el: HTMLImageElement,
  revokeBlob: (el: HTMLImageElement) => void,
): boolean {
  const state = el.getAttribute(STATE);
  if (state !== "done" && state !== "error") return false;
  revokeBlob(el);
  el.removeAttribute(STATE);
  el.removeAttribute(ORIG_SRC);
  el.removeAttribute(ORIG_SRCSET);
  return true;
}
