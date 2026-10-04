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

  it("rejects elements the extension already processed", () => {
    expect(isMangaCandidate(img({ src: "/a.jpg", "data-mt-state": "pending" }))).toBe(false);
    expect(isMangaCandidate(img({ src: "/a.jpg", "data-mt-state": "done" }))).toBe(false);
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

  it("dedupes same element+URL, keeps distinct elements of same URL", () => {
    const a = img({ src: "/same.jpg" });
    const b = img({ src: "/same.jpg" });
    const q = new TranslateQueue();
    q.enqueue(a);
    q.enqueue(a); // double-observe of the same element must not double-queue
    expect(q.size).toBe(1);
    q.enqueue(b); // two page slots sharing one URL are two translations
    expect(q.size).toBe(2);
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
