// Content script: candidate discovery, single-file translate queue, image swap.
import { isMangaCandidate, isVisibleCandidate, resolveImageUrl, TranslateQueue } from "./discover";
import { composePage } from "./render";
import { loadSettings } from "./settings";
import type { TranslateResponse } from "./types";

const MAX_CONTEXT = 20;
const STATE = "data-mt-state";
const ORIG_SRC = "data-mt-original-src";
const ORIG_SRCSET = "data-mt-original-srcset";

const queue = new TranslateQueue();
const blobs = new Map<HTMLImageElement, string>();
const translations: string[] = []; // rolling context, completed pages only
let autoMode = false;

async function initAutoMode(): Promise<void> {
  const settings = await loadSettings(); // throws without storage permission
  autoMode = settings.autoSites.includes(location.hostname);
}
initAutoMode().catch(() => {
  autoMode = false;
});

/* ---------------- UI ---------------- */

const btn = document.createElement("button");
btn.type = "button";
btn.textContent = "Dịch";
btn.className = "mt-translate-btn";
btn.style.cssText =
  "position:absolute;z-index:2147483647;padding:4px 10px;font:13px sans-serif;" +
  "background:#1b2a4a;color:#fff;border:0;border-radius:4px;cursor:pointer;opacity:.92";

const badge = document.createElement("div");
badge.className = "mt-error-badge";
badge.style.cssText =
  "position:absolute;z-index:2147483647;padding:3px 8px;font:12px sans-serif;" +
  "background:#b3261e;color:#fff;border-radius:4px;cursor:pointer";

let overlayHost: HTMLElement | null = null;

function placeOverlay(node: HTMLElement, el: HTMLImageElement): void {
  const r = el.getBoundingClientRect();
  node.style.left = `${Math.max(0, r.left + window.scrollX + 6)}px`;
  node.style.top = `${Math.max(0, r.top + window.scrollY + 6)}px`;
  (document.body ?? document.documentElement).appendChild(node);
  overlayHost = node;
}

function clearOverlay(node: HTMLElement): void {
  node.remove();
  if (overlayHost === node) overlayHost = null;
}

function showButton(el: HTMLImageElement): void {
  if (el.getAttribute(STATE)) return;
  clearOverlay(btn);
  placeOverlay(btn, el);
  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    enqueue(el, { priority: true });
    clearOverlay(btn);
  };
}

function showError(el: HTMLImageElement): void {
  el.setAttribute(STATE, "error");
  clearOverlay(btn);
  placeOverlay(badge, el);
  badge.textContent = "Lỗi — bấm để thử lại";
  badge.onclick = (e) => {
    e.preventDefault();
    el.removeAttribute(STATE);
    enqueue(el, { priority: true });
    clearOverlay(badge);
  };
}

document.addEventListener(
  "mouseover",
  (e) => {
    const el = e.target;
    if (el instanceof HTMLImageElement && isMangaCandidate(el)) showButton(el);
  },
  true,
);
document.addEventListener(
  "focusin",
  (e) => {
    const el = e.target;
    if (el instanceof HTMLImageElement && isMangaCandidate(el)) {
      el.setAttribute("tabindex", "0");
      showButton(el);
    }
  },
  true,
);
document.addEventListener("mouseout", (e) => {
  if (e.target === btn || e.target instanceof HTMLImageElement) clearOverlay(btn);
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
  queue.enqueue(el, opts);
  void pump();
  if (overlayHost === btn) clearOverlay(btn);
}

async function pump(): Promise<void> {
  while (true) {
    const el = queue.dequeue();
    if (!el) return;
    el.setAttribute(STATE, "pending");
    try {
      await translateOne(el);
      el.setAttribute(STATE, "done");
    } catch (err) {
      showError(el);
      console.error("MT translate failed:", err);
    } finally {
      queue.settle();
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

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      if (el instanceof HTMLImageElement && autoMode) enqueue(el);
    }
  },
  { rootMargin: "1500px 0px" },
);

function scan(root: ParentNode): void {
  for (const img of root.querySelectorAll("img")) {
    if (isMangaCandidate(img)) observer.observe(img);
  }
}
scan(document);

// Fallback when the browser command is unavailable (e.g. key taken);
// the registered command path forwards from background.ts instead.
document.addEventListener("keydown", (e) => {
  if (!e.altKey || (e.key !== "t" && e.key !== "T")) return;
  enqueueNearby();
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
      const state = el.getAttribute(STATE);
      if (state === "done" || state === "error") {
        revokeEl(el);
        el.removeAttribute(STATE);
        el.removeAttribute(ORIG_SRC);
        enqueue(el); // site swapped the source: re-evaluate
      }
    } else if (rec.type === "childList") {
      for (const node of rec.removedNodes) {
        if (!(node instanceof HTMLImageElement)) continue;
        revokeEl(node);
        queue.remove(node);
        observer.unobserve(node);
      }
      for (const node of rec.addedNodes) {
        if (node instanceof Element) scan(node);
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

// Background-driven retry (e.g. token fixed in options while a page errored)
// and the context menu "Dịch ảnh này" command.
chrome.runtime.onMessage.addListener(
  (msg: { type?: string; url?: string }, _sender, sendResponse) => {
    if (msg.type === "mt-retry-errors") {
      for (const img of document.querySelectorAll("img")) {
        if (img.getAttribute(STATE) === "error") {
          img.removeAttribute(STATE);
          enqueue(img);
        }
      }
    } else if (msg.type === "mt-enqueue-nearby") {
      // Alt+T arrives here as a browser command forwarded from background;
      // everything goes through the same sequential queue.
      enqueueNearby();
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
