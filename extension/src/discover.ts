// Image candidate discovery and the per-tab FIFO translate queue.
// No chrome.* imports here so tests run under jsdom.

const LAZY_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-hi-res-src"];
const MIN_EDGE = 100; // icons/ads live below this; manga pages are far above.
// Anything landscape and wider than this is reader chrome (ad slots, vote bars,
// site banners), not a page. A webtoon panel can legitimately sit at exactly
// 3:1, so the comparison is strict and the bound is deliberately not "widest
// real page we have seen" — that would shrink the rule as sites change.
const BANNER_ASPECT = 3;
const STATE_ATTR = "data-mt-state";
// Set while our own translated blob is on screen, and the only thing that
// distinguishes it from a page-owned blob (both carry the page's origin).
const ORIG_SRC_ATTR = "data-mt-original-src";
// Same discriminator for background-carried pages (see resolveBackgroundUrl).
const ORIG_BG_ATTR = "data-mt-original-bg";
// Readers like Pixiv paint each page as a div's background-image, so candidate
// discovery must accept non-img elements that carry a real background URL.
const BG_URL = /url\(["']?([^"')]+)["']?\)/;
// Baseline of each element's inline background-image, recorded at first
// evaluation. A background URL the site has not replaced since we first saw it
// is indistinguishable from a not-yet-real placeholder (Pixiv parks a blank
// http image on the div until its decoder publishes the real bitmap), so an
// http(s) background qualifies only after the site itself changed it. A blob:
// URL always qualifies: it can only exist after the site decoded the real
// page. Consequence: a site serving its final page image directly as an
// unchanged http URL is not discoverable — that limitation is inherent to the
// rule, not a bug.
const firstSeenBG = new WeakMap<Element, string>();

function largestSrcset(urls: string): string | null {
  let bestUrl: string | null = null;
  let bestW = -1;
  for (const part of urls.split(",")) {
    const [url, desc] = part.trim().split(/\s+/);
    if (!url) continue;
    const w = desc && /^\d+w$/.test(desc) ? parseInt(desc, 10) : 0;
    if (w > bestW || (bestUrl === null && w === 0)) {
      bestUrl = url;
      bestW = w;
    }
  }
  return bestUrl;
}

/** The element's background-image URL, or null when it has none we can use. */
function resolveBackgroundUrl(el: Element): string | null {
  // Inline style first: that is where readers put the page bitmap, and it is
  // the value we would have saved a swap from. getComputedStyle also covers
  // stylesheet-carried backgrounds, but a candidate whose URL lives only in a
  // stylesheet cannot be swapped without clobbering the class it came from, so
  // it is deliberately not a candidate.
  const raw = el instanceof HTMLElement ? el.style.backgroundImage : "";
  const m = BG_URL.exec(raw || "");
  if (!m) return null;
  const url = m[1].trim();
  if (!url || url.startsWith("data:")) return null; // inline placeholders
  // Same guard as the img path: our own blob must never re-enter the queue.
  if (url.startsWith("blob:") && el.getAttribute(ORIG_BG_ATTR)) return null;
  try {
    const resolved = new URL(url, document.baseURI).toString();
    if (resolved.startsWith("blob:")) return resolved;
    if (!/^https?:/.test(resolved)) return null;
    const baseline = firstSeenBG.get(el);
    if (baseline === undefined) {
      firstSeenBG.set(el, raw);
      // First sight of an http background: it may still be the pre-load
      // placeholder, and an unchanged value cannot be distinguished from one,
      // so it does not qualify until the site replaces it.
      return null;
    }
    if (raw === baseline) return null; // unchanged since first sight
    return resolved;
  } catch {
    return null;
  }
}

/** Best real image URL for an element, or null for placeholders. */
export function resolveImageUrl(el: Element): string | null {
  if (!(el instanceof HTMLImageElement)) return resolveBackgroundUrl(el);
  const candidates: (string | null)[] = [largestSrcset(el.getAttribute("srcset") || "")];
  for (const attr of LAZY_ATTRS) candidates.push(el.getAttribute(attr));
  candidates.push(el.getAttribute("src"));
  for (const raw of candidates) {
    if (!raw || raw.startsWith("data:")) continue; // inline placeholders
    // Sites like MangaDex serve reader pages as blob: URLs, so the scheme alone
    // cannot be a rejection reason. What must never re-enter the queue is the
    // blob WE swapped in: that element still holds our saved original, which is
    // the discriminator (an extension-created blob URL carries the page origin,
    // so it is indistinguishable by origin).
    if (raw.startsWith("blob:") && el.getAttribute(ORIG_SRC_ATTR)) continue;
    try {
      const url = new URL(raw, document.baseURI).toString();
      // Vector art (payment logos, icons) is rasterized by the page at any px
      // size, so px checks cannot filter it; the server only handles rasters.
      if (/\.svg(?:$|[?#])/i.test(url)) continue;
      return url;
    } catch {
      continue;
    }
  }
  return null;
}

function knownSize(el: HTMLImageElement): { w: number; h: number } | null {
  const attr = (n: string): number => {
    const v = Number.parseInt(el.getAttribute(n) || "", 10);
    return Number.isFinite(v) ? v : 0;
  };
  const w = el.naturalWidth || attr("width");
  const h = el.naturalHeight || attr("height");
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * A zero dimension means "not laid out yet", which is a visibility question for
 * `isVisibleCandidate` at dispatch time, not evidence of a banner.
 */
function isBanner(w: number, h: number): boolean {
  return w > 0 && h > 0 && w / h > BANNER_ASPECT;
}

export function isMangaCandidate(el: Element): boolean {
  if (el.getAttribute(STATE_ATTR) === "pending" || el.getAttribute(STATE_ATTR) === "done") {
    return false;
  }
  if (!resolveImageUrl(el)) return false;
  if (!(el instanceof HTMLImageElement)) {
    // A background element has no intrinsic size, so the rendered box is the
    // only size signal available, and the same edge also keeps small decorated
    // divs (buttons, separators) out of the queue.
    const r = el.getBoundingClientRect();
    if (!(r.width >= MIN_EDGE && r.height >= MIN_EDGE)) return false;
    return !isBanner(r.width, r.height);
  }
  const size = knownSize(el);
  if (!size) {
    // Unloaded lazy image: size decides at dispatch time. The rect is still
    // worth judging, because a reader that never sets width/height attributes
    // would otherwise leave wide banners in the queue forever.
    const r = el.getBoundingClientRect();
    return !isBanner(r.width, r.height);
  }
  if (Math.max(size.w, size.h) < MIN_EDGE || Math.min(size.w, size.h) < MIN_EDGE) return false;
  return !isBanner(size.w, size.h);
}

/**
 * Dispatch-time rendered-size gate: `display:none` thumbnails and unloaded
 * placeholders have a 0x0 rect. Without this check they consume the
 * sequential queue and starve the images actually on screen.
 */
export function isVisibleCandidate(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width >= MIN_EDGE && r.height >= MIN_EDGE;
}

interface Entry {
  el: Element;
  url: string;
  priority: boolean;
}

export class TranslateQueue {
  private entries: Entry[] = [];
  private current: Entry | null = null;

  get size(): number {
    return this.entries.length;
  }

  get inFlight(): boolean {
    return this.current !== null;
  }

  enqueue(el: Element, opts: { priority?: boolean } = {}): void {
    const url = resolveImageUrl(el);
    if (!url) return;
    // Dedupe on the URL alone, not (element, url): a paged reader can mount two
    // nodes for one page, and the same node can be re-observed with a new src.
    // Either way the page is the same bitmap, so a second job would be a second
    // identical translation — and the per-call LLM cost of paying for it twice.
    if (this.current?.url === url) return;
    if (this.entries.some((e) => e.url === url)) return;
    this.entries.push({ el, url, priority: opts.priority === true });
  }

  /** Oldest job (DOM order), or undefined while a job is in flight. */
  dequeue(): Element | undefined {
    if (this.current || this.entries.length === 0) return undefined;
    this.entries.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority ? -1 : 1;
      const pos = a.el.compareDocumentPosition(b.el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    this.current = this.entries.shift() ?? null;
    return this.current?.el;
  }

  settle(): void {
    this.current = null;
  }

  /** Drop a queued entry (element left the DOM or failed re-evaluation). */
  remove(el: Element): void {
    this.entries = this.entries.filter((e) => e.el !== el);
    if (this.current?.el === el) this.current = null;
  }
}
