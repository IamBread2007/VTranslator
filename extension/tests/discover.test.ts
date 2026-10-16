// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveImageUrl,
  isMangaCandidate,
  isVisibleCandidate,
  TranslateQueue,
} from "../src/discover";

function img(attrs: Record<string, string>): HTMLImageElement {
  const el = document.createElement("img");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("resolveImageUrl", () => {
  it("prefers lazy-load attributes over src", () => {
    const el = img({
      src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
      "data-lazy-src": "/manga/p1.jpg",
      "data-src": "/manga/p1-src.jpg",
    });
    expect(resolveImageUrl(el)).toMatch(/\/manga\/p1-src\.jpg$/);
  });

  it("falls back to data-lazy-src then data-original", () => {
    const lazy = img({ src: "placeholder.png", "data-lazy-src": "/manga/lazy.jpg" });
    expect(resolveImageUrl(lazy)).toMatch(/\/manga\/lazy\.jpg$/);
    const original = img({ src: "x.gif", "data-original": "/manga/orig.jpg" });
    expect(resolveImageUrl(original)).toMatch(/\/manga\/orig\.jpg$/);
  });

  it("chooses the largest srcset candidate", () => {
    const el = img({
      src: "/small.jpg",
      srcset: "/a.jpg 480w, /b.jpg 1600w, /c.jpg 800w",
    });
    expect(resolveImageUrl(el)).toMatch(/\/b\.jpg$/);
  });

  it("resolves relative URLs against the page", () => {
    const el = img({ src: "manga/page-001.jpg" });
    const out = resolveImageUrl(el);
    expect(out).toMatch(/^https?:\/\//);
    expect(out).toMatch(/\/manga\/page-001\.jpg$/);
  });

  it("returns null for data: placeholders", () => {
    const el = img({ src: "data:image/gif;base64,R0lGODAQEAAQABAAD" });
    expect(resolveImageUrl(el)).toBeNull();
  });

  it("accepts a page-owned blob: source", () => {
    // MangaDex serves every reader page as blob:https://mangadex.org/<uuid>, so
    // rejecting the scheme outright meant no image ever entered the queue.
    const el = img({ src: "blob:https://mangadex.org/6f1c6f2e-6a2f-4a1e-9d6f-2f4b1c0a9e11" });
    expect(resolveImageUrl(el)).toBe("blob:https://mangadex.org/6f1c6f2e-6a2f-4a1e-9d6f-2f4b1c0a9e11");
  });

  it("rejects the blob we swapped in ourselves", () => {
    // Our own output: the element keeps the source we saved while the blob is on
    // screen, and re-translating it would recurse into a second pass. The origin
    // cannot tell the two apart (both are blob:<page origin>), so the saved
    // source attribute is the discriminator.
    const el = img({
      src: "blob:https://mangadex.org/aa11bb22-cc33-dd44-ee55-ff6677889900",
      "data-mt-original-src": "https://cmdxd98sb0x3yprd.mangadex.network/data/abc/1-x.png",
    });
    expect(resolveImageUrl(el)).toBeNull();
  });

  it("resolves the site URL again once the original is shown", () => {
    // showOriginal() restores the site's URL, so the element must not stay
    // locked out by the blob guard.
    const el = img({
      src: "https://cmdxd98sb0x3yprd.mangadex.network/data/abc/1-x.png",
      "data-mt-original-src": "https://cmdxd98sb0x3yprd.mangadex.network/data/abc/1-x.png",
    });
    expect(resolveImageUrl(el)).toMatch(/1-x\.png$/);
  });
});

describe("isMangaCandidate", () => {
  it("rejects known-small images", () => {
    expect(isMangaCandidate(img({ src: "/a.jpg", width: "40", height: "60" }))).toBe(false);
    // A wide banner strip is not a manga page either.
    expect(isMangaCandidate(img({ src: "/b.jpg", width: "900", height: "90" }))).toBe(false);
  });

  it("accepts known-large images", () => {
    expect(isMangaCandidate(img({ src: "/a.jpg", width: "800", height: "1200" }))).toBe(true);
  });

  it("accepts unloaded images with unknown size", () => {
    // Lazy images often carry no dimensions before they enter the viewport.
    expect(isMangaCandidate(img({ src: "/c.jpg" }))).toBe(true);
  });

  it("rejects data: placeholders but accepts a page-owned blob", () => {
    expect(isMangaCandidate(img({ src: "data:image/gif;base64,AAA" }))).toBe(false);
    expect(isMangaCandidate(img({ src: "blob:http://site/uuid", width: "800", height: "1200" }))).toBe(true);
  });

  it("rejects vector logos (svg)", () => {
    // Payment/logo SVGs are large enough in px but are not manga pages.
    expect(isMangaCandidate(img({ src: "/assets/visa-white-B2cVp6Zn.svg", width: "244", height: "150" }))).toBe(false);
    expect(resolveImageUrl(img({ src: "/logo.svg" }))).toBeNull();
  });

  it("rejects avatar-sized images but keeps the 200px boundary a candidate", () => {
    // Regression: comix.to comment avatars are 128x128 and used to inflate
    // the Alt+T count. The 200px cases pin the threshold against drift.
    expect(isMangaCandidate(img({ src: "/avatar.webp", width: "128", height: "128" }))).toBe(false);
    expect(isMangaCandidate(img({ src: "/edge.jpg", width: "200", height: "200" }))).toBe(true);
    expect(isMangaCandidate(img({ src: "/strip.jpg", width: "200", height: "2400" }))).toBe(true);
  });

  it("rejects elements the extension already processed", () => {
    expect(isMangaCandidate(img({ src: "/a.jpg", "data-mt-state": "pending" }))).toBe(false);
    expect(isMangaCandidate(img({ src: "/a.jpg", "data-mt-state": "done" }))).toBe(false);
  });

  it("rejects reaction-sticker images even when their size says page", () => {
    // Reaction-vote widgets mount hundreds of unloaded alt="sticker" images with
    // distinct URLs. A loaded-size sticker proves the alt gate works after (and
    // independently of) the size rules.
    expect(isMangaCandidate(img({ src: "/s.webp", alt: "sticker", width: "800", height: "1200" }))).toBe(false);
  });

  it("keeps a normal alt untouched", () => {
    expect(isMangaCandidate(img({ src: "/p.jpg", alt: "Page 5" }))).toBe(true);
  });
});

describe("TranslateQueue", () => {
  it("keeps FIFO in DOM order regardless of enqueue order", () => {
    const first = img({ src: "/1.jpg" });
    const second = img({ src: "/2.jpg" });
    const q = new TranslateQueue();
    q.enqueue(second);
    q.enqueue(first);
    expect(q.dequeue()).toBe(first);
    q.settle(); // concurrency stays 1: next dispatch only after settle
    expect(q.dequeue()).toBe(second);
    expect(q.size).toBe(0);
  });

  it("dedupes on the URL, so one page never costs two translations", () => {
    const a = img({ src: "/same.jpg" });
    const b = img({ src: "/same.jpg" });
    const q = new TranslateQueue();
    q.enqueue(a);
    q.enqueue(a); // double-observe of the same element must not double-queue
    expect(q.size).toBe(1);
    // Two page slots sharing one URL are the same bitmap. Translating it twice
    // would pay the full LLM cost again for an identical result, and in a paged
    // reader MangaDex genuinely mounts two nodes for one page.
    q.enqueue(b);
    expect(q.size).toBe(1);
  });

  it("still queues the same node again after the reader swaps its source", () => {
    const el = img({ src: "/p1.jpg" });
    const q = new TranslateQueue();
    q.enqueue(el);
    expect(q.dequeue()).toBe(el);
    q.settle();
    // The site republished the node with a different bitmap; that is new work.
    el.setAttribute("src", "/p2.jpg");
    q.enqueue(el);
    expect(q.size).toBe(1);
  });

  it("does not queue a URL that is already in flight", () => {
    const a = img({ src: "/same.jpg" });
    const b = img({ src: "/same.jpg" });
    const q = new TranslateQueue();
    q.enqueue(a);
    expect(q.dequeue()).toBe(a);
    q.enqueue(b); // same page, different node, while the first is running
    expect(q.size).toBe(0);
  });

  it("gives manual jobs priority without parallel dispatch", () => {
    const auto = img({ src: "/1.jpg" });
    const manual = img({ src: "/2.jpg" });
    const q = new TranslateQueue();
    q.enqueue(auto);
    q.enqueue(manual, { priority: true });
    expect(q.dequeue()).toBe(manual);
    expect(q.inFlight).toBe(true);
    expect(q.dequeue()).toBeUndefined(); // no parallel job while in flight
    q.settle();
    expect(q.dequeue()).toBe(auto);
  });
});

describe("isVisibleCandidate", () => {
  function rendered(el: HTMLImageElement, w: number, h: number): HTMLImageElement {
    el.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: w, height: h, top: 0, left: 0, right: w, bottom: h, toJSON: () => ({}) }) as DOMRect;
    return el;
  }

  it("rejects images with no rendered box (hidden or unloaded placeholders)", () => {
    // jsdom rects are 0x0; this mirrors display:none thumbnails that used to
    // fill the queue and starve the images actually on screen.
    expect(isVisibleCandidate(img({ src: "/hero.jpg", width: "726", height: "1200" }))).toBe(false);
  });

  it("accepts a gallery-sized rendered image", () => {
    expect(isVisibleCandidate(rendered(img({ src: "/p1.jpg" }), 500, 826))).toBe(true);
  });

  it("rejects images rendered smaller than the minimum edge", () => {
    expect(isVisibleCandidate(rendered(img({ src: "/strip.jpg" }), 60, 400))).toBe(false);
    expect(isVisibleCandidate(rendered(img({ src: "/bar.jpg" }), 900, 80))).toBe(false);
  });
});

function bgDiv(bg?: string): HTMLDivElement {
  const el = document.createElement("div");
  if (bg) el.style.backgroundImage = bg;
  document.body.appendChild(el);
  return el;
}

function renderedEl(el: HTMLElement, w: number, h: number): HTMLElement {
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: w, height: h, top: 0, left: 0, right: w, bottom: h, toJSON: () => ({}) }) as DOMRect;
  return el;
}

describe("resolveImageUrl on background-image elements", () => {
  it("rejects a div with no inline background-image", () => {
    expect(resolveImageUrl(bgDiv())).toBeNull();
  });

  it("rejects a data: background placeholder", () => {
    expect(resolveImageUrl(bgDiv('url("data:image/gif;base64,R0lGOD")'))).toBeNull();
  });

  it("returns null on first sight of an http background, then qualifies once the site replaces it", () => {
    // The first value may be a pre-load placeholder bitmap; only a site-driven
    // replacement proves a real page image is being served.
    const el = bgDiv('url("https://reader.example/preload.png")');
    expect(resolveImageUrl(el)).toBeNull();

    el.style.backgroundImage = 'url("https://reader.example/page-001.jpg")';
    expect(resolveImageUrl(el)).toBe("https://reader.example/page-001.jpg");
  });

  it("rejects an http background the site never replaced after the baseline was recorded", () => {
    const el = bgDiv('url("https://reader.example/preload.png")');
    expect(resolveImageUrl(el)).toBeNull(); // baseline recorded
    expect(resolveImageUrl(el)).toBeNull(); // unchanged → still a placeholder
  });

  it("accepts a page-owned blob: background on first sight", () => {
    const el = bgDiv('url("blob:https://comic.pixiv.net/26f59ef2-abc")');
    expect(resolveImageUrl(el)).toBe("blob:https://comic.pixiv.net/26f59ef2-abc");
  });

  it("rejects the background blob we swapped in ourselves", () => {
    const el = bgDiv('url("blob:https://comic.pixiv.net/our-translation")');
    el.setAttribute("data-mt-original-bg", 'url("blob:https://comic.pixiv.net/page-1")');
    expect(resolveImageUrl(el)).toBeNull();
  });

  it("leaves <img> resolution byte-identical (img src still resolves)", () => {
    expect(resolveImageUrl(img({ src: "/manga/page-001.jpg" }))).toMatch(/\/manga\/page-001\.jpg$/);
  });
});

describe("isMangaCandidate on background-image elements", () => {
  it("rejects a background div without a resolvable URL", () => {
    expect(isMangaCandidate(bgDiv())).toBe(false);
  });

  it("accepts a blob: background div rendered at page size", () => {
    const el = renderedEl(bgDiv('url("blob:https://comic.pixiv.net/page-0")'), 634, 751);
    expect(isMangaCandidate(el)).toBe(true);
  });

  it("rejects a blob: background div rendered below the minimum edge", () => {
    const el = renderedEl(bgDiv('url("blob:https://comic.pixiv.net/icon")'), 48, 48);
    expect(isMangaCandidate(el)).toBe(false);
  });

  it("rejects a background div already done", () => {
    const el = renderedEl(bgDiv('url("blob:https://comic.pixiv.net/page-1")'), 634, 751);
    el.setAttribute("data-mt-state", "done");
    expect(isMangaCandidate(el)).toBe(false);
  });
});

describe("TranslateQueue with background elements", () => {
  it("queues, dedupes and dequeues a background div", () => {
    const el = bgDiv('url("blob:https://comic.pixiv.net/page-2")');
    const q = new TranslateQueue();
    q.enqueue(el);
    q.enqueue(el); // same node + same URL → deduped
    expect(q.size).toBe(1);
    expect(q.dequeue()).toBe(el);
    q.settle();
  });
});

describe("TranslateQueue.clear", () => {
  it("drops queued work but leaves the in-flight job alone", () => {
    // Stop clears the remainder; the in-flight page is reverted by content.ts,
    // not by the queue, so clear() must not strand it with nothing to settle.
    const a = img({ src: "/1.jpg" });
    const b = img({ src: "/2.jpg" });
    const q = new TranslateQueue();
    q.enqueue(a);
    q.enqueue(b);
    expect(q.dequeue()).toBe(a);
    q.clear();
    expect(q.size).toBe(0);
    expect(q.inFlight).toBe(true);
    q.settle();
    expect(q.inFlight).toBe(false);
  });

  it("lets a fresh page be enqueued after a stop", () => {
    const q = new TranslateQueue();
    q.enqueue(img({ src: "/1.jpg" }));
    q.clear();
    q.enqueue(img({ src: "/2.jpg" }));
    expect(q.size).toBe(1);
  });
});

describe("banner rejection", () => {
  it("rejects a 4:1 landscape banner sized intrinsically", () => {
    const el = img({ src: "/ad.jpg", width: "1200", height: "300" });
    expect(isMangaCandidate(el)).toBe(false);
  });

  it("rejects a 4:1 landscape banner measured from its rendered box", () => {
    // No width/height attributes, so only the rect can catch it. Without this
    // the rule would silently not apply on a reader that sets no intrinsic size.
    const el = renderedEl(img({ src: "/ad.jpg" }), 1200, 300);
    expect(isMangaCandidate(el)).toBe(false);
  });

  it("rejects a 4:1 background banner", () => {
    const el = renderedEl(bgDiv('url("blob:https://reader.example/ad")'), 1200, 300);
    expect(isMangaCandidate(el)).toBe(false);
  });

  it("accepts a legitimate wide panel at exactly 3:1", () => {
    // Review Focus #2: the bound is exclusive, so 3:1 itself stays a page. Both
    // size sources are pinned, since a `>=` slip would only break one of them.
    expect(isMangaCandidate(img({ src: "/wide.jpg", width: "900", height: "300" }))).toBe(true);
    expect(isMangaCandidate(renderedEl(img({ src: "/wide.jpg" }), 900, 300))).toBe(true);
  });

  it("never rejects a portrait page however narrow", () => {
    expect(isMangaCandidate(img({ src: "/tall.jpg", width: "200", height: "2400" }))).toBe(true);
  });

  it("does not reject an unloaded box for having zero height", () => {
    // Zero height means "not yet laid out", which is isVisibleCandidate's gate.
    expect(isMangaCandidate(renderedEl(img({ src: "/page.jpg" }), 800, 0))).toBe(true);
    expect(isMangaCandidate(img({ src: "/page.jpg" }))).toBe(true);
  });

  it("accepts every real MangaDex page shape, including a 367px-wide page", () => {
    expect(isMangaCandidate(renderedEl(img({ src: "blob:https://mangadex.org/x" }), 367, 640))).toBe(true);
  });
});
