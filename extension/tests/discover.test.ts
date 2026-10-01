// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { resolveImageUrl, isMangaCandidate, TranslateQueue } from "../src/discover";

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

  it("rejects data: placeholders and blob: URLs", () => {
    expect(isMangaCandidate(img({ src: "data:image/gif;base64,AAA" }))).toBe(false);
    expect(isMangaCandidate(img({ src: "blob:http://site/uuid" }))).toBe(false);
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
