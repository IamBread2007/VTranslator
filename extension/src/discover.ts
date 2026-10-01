// Image candidate discovery and the per-tab FIFO translate queue.
// No chrome.* imports here so tests run under jsdom.

const LAZY_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-hi-res-src"];
const MIN_EDGE = 100; // icons/ads live below this; manga pages are far above.
const STATE_ATTR = "data-mt-state";

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

/** Best real image URL for an element, or null for placeholders. */
export function resolveImageUrl(el: HTMLImageElement): string | null {
  const candidates: (string | null)[] = [largestSrcset(el.getAttribute("srcset") || "")];
  for (const attr of LAZY_ATTRS) candidates.push(el.getAttribute(attr));
  candidates.push(el.getAttribute("src"));
  for (const raw of candidates) {
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) continue; // placeholders and extension-created blobs
    try {
      return new URL(raw, document.baseURI).toString();
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

export function isMangaCandidate(el: HTMLImageElement): boolean {
  if (el.getAttribute(STATE_ATTR) === "pending" || el.getAttribute(STATE_ATTR) === "done") {
    return false;
  }
  if (!resolveImageUrl(el)) return false;
  const size = knownSize(el);
  if (!size) return true; // unloaded lazy image: size decides at dispatch time
  return Math.max(size.w, size.h) >= MIN_EDGE && Math.min(size.w, size.h) >= MIN_EDGE;
}

interface Entry {
  el: HTMLImageElement;
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

  enqueue(el: HTMLImageElement, opts: { priority?: boolean } = {}): void {
    const url = resolveImageUrl(el);
    if (!url) return;
    // Dedupe key is (element, canonical URL): the same node observed twice is
    // skipped, but a site swapping its URL re-queues it for re-evaluation.
    const dup = (e: Entry) => e.el === el && e.url === url;
    if (this.current && dup(this.current)) return;
    if (this.entries.some(dup)) return;
    this.entries.push({ el, url, priority: opts.priority === true });
  }

  /** Oldest job (DOM order), or undefined while a job is in flight. */
  dequeue(): HTMLImageElement | undefined {
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
  remove(el: HTMLImageElement): void {
    this.entries = this.entries.filter((e) => e.el !== el);
    if (this.current?.el === el) this.current = null;
  }
}
