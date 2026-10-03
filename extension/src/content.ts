// Content script: candidate discovery, single-file translate queue, image swap.
import { isMangaCandidate, isVisibleCandidate, resolveImageUrl, TranslateQueue } from "./discover";
import { composePage } from "./render";
import { STATE, ORIG_SRC, ORIG_SRCSET, onSiteSourceSwap } from "./imgsrc";
import { badgeFor, collectCounts, emptyView, summarize, TTL_MS } from "./hudstate";
import { createHud } from "./hud";
import { OverlayLayer } from "./overlay";
import type { TranslateResponse } from "./types";

const MAX_CONTEXT = 20;

const queue = new TranslateQueue();
const blobs = new Map<HTMLImageElement, string>();
const translations: string[] = []; // rolling context, completed pages only

/* ---------------- UI ---------------- */

const hud = createHud();
const layer = new OverlayLayer();

// Counts enqueues that really created work, so a trigger that discovered
// nothing can be told apart from a broken one.
let enqueues = 0;

/**
 * Refresh the page HUD and this tab's toolbar badge after any state change.
 * The badge is pushed here rather than polled because a content script is the
 * only place that sees both the DOM states and the queue's in-flight work.
 */
function syncHud(): void {
  const c = collectCounts(document, queue.size > 0 || queue.inFlight);
  // The service worker may not exist yet when a page loads, or may have just
  // been reloaded with the extension; the badge is optional UI garnish, so a
  // dead endpoint must not break the HUD path. Reported at debug level only —
  // a missing service worker on page load is expected, not an incident.
  void chrome.runtime
    .sendMessage({ type: "mt-progress", badge: badgeFor(c) })
    .catch((err: unknown) => {
      console.debug("mt: toolbar badge update skipped:", err);
    });
  if (c.running) {
    hud.update(c);
    return;
  }
  if (c.error > 0) {
    hud.update(c);
    return;
  }
  if (c.done > 0) {
    hud.flash(summarize(c), TTL_MS.done);
    return;
  }
  hud.update(c); // idle → hide the pill, no residue on an untouched page
}

// One singleton node: the overlay layer anchors one node to one image, so the
// previous anchor must be cleared before the button can follow the cursor.
const hoverBtn = document.createElement("button");
hoverBtn.type = "button";
hoverBtn.textContent = "Dịch";
hoverBtn.className = "mt-translate-btn";
// Position/z-index come from OverlayLayer.styleFor, not here.
hoverBtn.style.cssText =
  "padding:4px 10px;font:13px sans-serif;background:#1b2a4a;color:#fff;" +
  "border:0;border-radius:4px;cursor:pointer;opacity:.92";

let hoverAnchor: HTMLImageElement | null = null;

function clearHover(): void {
  if (!hoverAnchor) return;
  layer.clear(hoverAnchor);
  hoverAnchor = null;
}

function showHover(el: HTMLImageElement): void {
  if (el.getAttribute(STATE)) return; // a settled or in-flight image speaks through its own chip/ring
  if (hoverAnchor === el) return;
  clearHover();
  hoverAnchor = el;
  layer.set(el, hoverBtn);
}

hoverBtn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const el = hoverAnchor;
  clearHover(); // the button must not linger over the image the user just clicked
  if (el) enqueue(el, { priority: true });
});

// Per-image pending rings: a fresh node per image so several images can show
// "being worked on" at once instead of one shared indicator.
const rings = new Map<HTMLImageElement, HTMLElement>();

function showRing(el: HTMLImageElement): void {
  // The ring takes the slot the hover button may be holding on this image.
  if (hoverAnchor === el) clearHover();
  let node = rings.get(el);
  if (!node) {
    node = document.createElement("div");
    node.className = "mt-ring";
    rings.set(el, node);
  }
  layer.cover(el, node);
}

function dropRing(el: HTMLImageElement): void {
  if (!rings.delete(el)) return;
  layer.clear(el);
}

function flashDone(el: HTMLImageElement): void {
  const chip = document.createElement("span");
  chip.textContent = "✓";
  // hud.ts only styles whole pills (`.mt-hud--ok` alone has no text colour, no
  // padding and no radius), so the per-image tick carries its own minimal look
  // instead of inheriting a pill rule it was never meant for.
  chip.style.cssText =
    "background:#0b6b32;color:#fff;border-radius:4px;padding:2px 6px;font:12px/1.2 sans-serif";
  layer.flashChip(el, chip, TTL_MS.chip);
}

// Error chips: one node per image, kept until the user retries — unlike the
// done tick, an error must not vanish while nobody has looked at it.
const errorChips = new Map<HTMLImageElement, HTMLElement>();

function showErrorChip(el: HTMLImageElement): void {
  dropErrorChip(el); // never stack a second chip on an already-flagged image
  const chip = document.createElement("span");
  chip.textContent = "Lỗi — bấm để thử lại";
  chip.style.cssText =
    "background:#b3261e;color:#fff;cursor:pointer;border-radius:4px;padding:2px 6px;font:12px/1.2 sans-serif";
  chip.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.removeAttribute(STATE);
    dropErrorChip(el);
    enqueue(el, { priority: true });
  });
  errorChips.set(el, chip);
  layer.set(el, chip);
}

function dropErrorChip(el: HTMLImageElement): void {
  if (!errorChips.delete(el)) return;
  layer.clear(el);
}

/** Drop every anchor we own for an image, e.g. one the page just removed. */
function dropAnchors(el: HTMLImageElement): void {
  rings.delete(el);
  errorChips.delete(el);
  if (hoverAnchor === el) hoverAnchor = null;
  layer.clear(el);
}

document.addEventListener(
  "mouseover",
  (e) => {
    const el = e.target;
    if (el instanceof HTMLImageElement && isMangaCandidate(el)) showHover(el);
  },
  true,
);
document.addEventListener(
  "focusin",
  (e) => {
    const el = e.target;
    if (el instanceof HTMLImageElement && isMangaCandidate(el)) {
      el.setAttribute("tabindex", "0");
      showHover(el);
    }
  },
  true,
);
document.addEventListener("mouseout", (e) => {
  // Entering the singleton button counts as leaving the image (the button is
  // anchored as a sibling, not a child), so without this guard the button would
  // be destroyed the moment the cursor reaches it and could never be clicked.
  if (e.relatedTarget instanceof Node && hoverBtn.contains(e.relatedTarget)) return;
  if (e.target === hoverBtn || e.target instanceof HTMLImageElement) clearHover();
});

/* ---------------- original view (hold click / Alt+O) ---------------- */

function showOriginal(el: HTMLImageElement): void {
  const orig = el.getAttribute(ORIG_SRC);
  if (!orig || el.getAttribute(STATE) !== "done") return;
  const current = blobs.get(el);
  el.setAttribute("src", orig);
  const origSet = el.getAttribute(ORIG_SRCSET);
  if (origSet) el.setAttribute("srcset", origSet);
  if (current) el.dataset.mtHiddenBlob = current;
}
function restoreTranslated(el: HTMLImageElement): void {
  const hidden = el.dataset.mtHiddenBlob;
  if (!hidden) return;
  el.setAttribute("src", hidden);
  delete el.dataset.mtHiddenBlob;
}
let holdTimer: number | undefined;
document.addEventListener("mousedown", (e) => {
  const el = e.target;
  if (el instanceof HTMLImageElement && el.getAttribute(STATE) === "done") {
    holdTimer = window.setTimeout(() => showOriginal(el), 400);
  }
});
document.addEventListener("mouseup", (e) => {
  window.clearTimeout(holdTimer);
  const el = e.target;
  if (el instanceof HTMLImageElement) restoreTranslated(el);
});
document.addEventListener("keydown", (e) => {
  if (!e.altKey || (e.key !== "o" && e.key !== "O")) return;
  const el = document.activeElement;
  if (el instanceof HTMLImageElement) showOriginal(el);
});
document.addEventListener("keyup", (e) => {
  if (e.key !== "o" && e.key !== "O") return;
  const el = document.activeElement;
  if (el instanceof HTMLImageElement) restoreTranslated(el);
});

/* ---------------- queue + dispatch ---------------- */

function enqueue(el: HTMLImageElement, opts: { priority?: boolean } = {}): void {
  if (el.getAttribute(STATE) === "pending" || el.getAttribute(STATE) === "done") return;
  if (!isMangaCandidate(el) || !isVisibleCandidate(el)) return;
  const queuedBefore = queue.size;
  queue.enqueue(el, opts);
  // TranslateQueue silently drops duplicates and images with no resolvable URL,
  // so only a size change means this call actually created work.
  if (queue.size === queuedBefore) return;
  enqueues++;
  void pump();
  syncHud();
}

async function pump(): Promise<void> {
  while (true) {
    const el = queue.dequeue();
    if (!el) return;
    el.setAttribute(STATE, "pending");
    showRing(el);
    try {
      await translateOne(el);
      el.setAttribute(STATE, "done");
      dropRing(el);
      flashDone(el);
    } catch (err) {
      el.setAttribute(STATE, "error");
      dropRing(el);
      showErrorChip(el);
      console.error("MT translate failed:", err);
    } finally {
      queue.settle();
      syncHud();
    }
  }
}

async function translateOne(el: HTMLImageElement): Promise<void> {
  const url = resolveImageUrl(el);
  if (!url) throw new Error("no image URL");
  // prevContext is read NOW, immediately before dispatch, so page N+1 always
  // carries page N's lines when both sit in the same queue.
  const prevContext = translations.slice(-MAX_CONTEXT);
  const resp = (await chrome.runtime.sendMessage({
    type: "translate",
    url,
    pageUrl: location.href,
    prevContext,
  })) as TranslateResponse | { error: string };
  if ("error" in resp) throw new Error(resp.error);

  const blob = await composePage(resp, {
    onOverflow: (id, minPx) => console.warn(`MT: block ${id} overflow at ${minPx}px`),
  });
  const objectUrl = URL.createObjectURL(blob);

  el.setAttribute(ORIG_SRC, url);
  const origSrcset = el.getAttribute("srcset");
  if (origSrcset) el.setAttribute(ORIG_SRCSET, origSrcset);
  el.removeAttribute("srcset"); // lazy loaders must not override our swap
  el.removeAttribute("data-src");

  const prevBlob = blobs.get(el);
  if (prevBlob) URL.revokeObjectURL(prevBlob);
  blobs.set(el, objectUrl);
  el.setAttribute("src", objectUrl);

  for (const block of resp.blocks) translations.push(block.translation);
  while (translations.length > MAX_CONTEXT) translations.shift();
}

/* ---------------- observation ---------------- */

// Nothing is translated on its own initiative: images reach the queue only
// through an explicit user action (hover button, Alt+T, context menu, retry),
// and each of those paths re-queries the live DOM at trigger time, so newly
// inserted images need no pre-scanning.

// Fallback when the browser command is unavailable (e.g. key taken);
// the registered command path forwards from background.ts instead.
document.addEventListener("keydown", (e) => {
  if (!e.altKey || (e.key !== "t" && e.key !== "T")) return;
  triggerNearby();
});

function revokeEl(el: HTMLImageElement): void {
  const blob = blobs.get(el);
  if (blob) {
    URL.revokeObjectURL(blob);
    blobs.delete(el);
  }
}

const mo = new MutationObserver((records) => {
  for (const rec of records) {
    if (rec.type === "attributes") {
      const el = rec.target;
      if (!(el instanceof HTMLImageElement)) continue;
      const next = el.getAttribute(rec.attributeName ?? "src") ?? "";
      // Our own swap produces blob: URLs; ignore it to avoid feedback loops.
      if (next.startsWith("blob:")) continue;
      // Stale translation bookkeeping is cleared, never re-queued: only an
      // explicit user action may start another translate.
      if (onSiteSourceSwap(el, revokeEl)) dropErrorChip(el); // the retry offer pointed at state that no longer exists
    } else if (rec.type === "childList") {
      for (const node of rec.removedNodes) {
        if (!(node instanceof HTMLImageElement)) continue;
        revokeEl(node);
        queue.remove(node);
        dropAnchors(node);
      }
    }
  }
});
mo.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["src", "srcset"],
  childList: true,
  subtree: true,
});

/** Queue every un-translated candidate within one viewport of the scroll. */
function enqueueNearby(): void {
  for (const img of document.querySelectorAll("img")) {
    if (!isMangaCandidate(img)) continue;
    const r = img.getBoundingClientRect();
    if (r.bottom >= -1500 && r.top <= window.innerHeight + 1500) enqueue(img);
  }
}

/**
 * Alt+T and its forwarded command share this wrapper so a discovery pass that
 * found no new work says so: a keypress with zero visible effect reads as a
 * broken shortcut, not as "nothing needed translating".
 */
function triggerNearby(): void {
  const before = enqueues;
  enqueueNearby();
  if (enqueues === before) hud.flash(emptyView(), TTL_MS.empty);
}

/** Every image in the error state, re-queued through the normal enqueue path. */
function retryErrors(): void {
  for (const img of document.querySelectorAll("img")) {
    if (img.getAttribute(STATE) === "error") {
      img.removeAttribute(STATE);
      dropErrorChip(img); // the offer is redeemed now; the ring will take its slot
      enqueue(img);
    }
  }
}

hud.onRetry(retryErrors);

// Background-driven retry (e.g. token fixed in options while a page errored)
// and the context menu "Dịch ảnh này" command.
chrome.runtime.onMessage.addListener(
  (msg: { type?: string; url?: string }, _sender, sendResponse) => {
    if (msg.type === "mt-retry-errors") {
      retryErrors();
    } else if (msg.type === "mt-enqueue-nearby") {
      // Alt+T arrives here as a browser command forwarded from background;
      // everything goes through the same sequential queue.
      triggerNearby();
    } else if (msg.type === "mt-translate-url" && msg.url) {
      // Context menu: enqueue the clicked image in the same queue.
      for (const img of document.querySelectorAll("img")) {
        const canonical = resolveImageUrl(img);
        if (canonical === msg.url || img.src === msg.url) {
          if (img.getAttribute(STATE) === "done" || img.getAttribute(STATE) === "pending") {
            sendResponse({ ok: false, reason: "already" });
            return undefined;
          }
          enqueue(img, { priority: true });
          sendResponse({ ok: true });
          return undefined;
        }
      }
      sendResponse({ ok: false, reason: "not found" });
    }
    return undefined;
  },
);

// One startup sync clears this tab's toolbar badge when a fresh page loads,
// before any user trigger has run — otherwise a badge from a previous page
// would outlive navigation.
syncHud();
