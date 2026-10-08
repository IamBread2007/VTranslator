// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  STATE,
  ORIG_SRC,
  ORIG_SRCSET,
  ORIG_BG,
  HIDDEN_BG,
  applyBackgroundSwap,
  restoreOriginalBackground,
  reapplyTranslatedBackground,
  takeOwnStyleWrites,
  onSiteSourceSwap,
} from "../src/imgsrc";

const SITE_SRC = "https://cdn.example.com/page-002.jpg";

function img(attrs: Record<string, string>): HTMLImageElement {
  const el = document.createElement("img");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

// Stands in for content.ts revokeEl: the map entry is what makes a revoke real,
// so the test asserts both the callback and the map cleanup.
function harness(el: HTMLImageElement, blobUrl: string) {
  const blobs = new Map<Element, string>(blobUrl ? [[el, blobUrl]] : []);
  const revoked: string[] = [];
  const revoke = vi.fn((target: Element) => {
    const url = blobs.get(target);
    if (url) {
      revoked.push(url);
      blobs.delete(target);
    }
  });
  return { blobs, revoked, revoke };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("onSiteSourceSwap", () => {
  it("resets a done image to the site source without translating it", () => {
    const el = img({
      src: SITE_SRC,
      [STATE]: "done",
      [ORIG_SRC]: "https://cdn.example.com/page-001.jpg",
    });
    const h = harness(el, "blob:https://cdn.example.com/old-translation");

    expect(onSiteSourceSwap(el, h.revoke)).toBe(true);
    expect(h.revoke).toHaveBeenCalledTimes(1);
    expect(h.revoke).toHaveBeenCalledWith(el);
    expect(h.revoked).toEqual(["blob:https://cdn.example.com/old-translation"]);
    expect(h.blobs.has(el)).toBe(false);
    expect(el.hasAttribute(STATE)).toBe(false);
    expect(el.hasAttribute(ORIG_SRC)).toBe(false);
    // The site's new source survives, and STATE stays absent: enqueue() is the
    // only path that writes "pending", so its absence proves nothing was queued.
    expect(el.getAttribute("src")).toBe(SITE_SRC);
    expect(el.getAttribute(STATE)).toBeNull();
  });

  it("resets an errored image that holds no saved original", () => {
    // An error swap may never have written data-mt-original-src, and the blob
    // may already be gone; the reset must still run so the image is reusable.
    const el = img({ src: SITE_SRC, [STATE]: "error" });
    const h = harness(el, "");

    expect(onSiteSourceSwap(el, h.revoke)).toBe(true);
    expect(h.revoke).toHaveBeenCalledTimes(1);
    expect(h.revoke).toHaveBeenCalledWith(el);
    expect(el.hasAttribute(STATE)).toBe(false);
    expect(el.hasAttribute(ORIG_SRC)).toBe(false);
    expect(el.getAttribute("src")).toBe(SITE_SRC);
  });

  it("drops our srcset suppression so the loader keeps working on the new image", () => {
    const el = img({
      src: SITE_SRC,
      [STATE]: "done",
      [ORIG_SRC]: "https://cdn.example.com/page-001.jpg",
      [ORIG_SRCSET]: "https://cdn.example.com/page-001.jpg 1200w",
    });
    const h = harness(el, "blob:example/stale");

    expect(onSiteSourceSwap(el, h.revoke)).toBe(true);
    // The saved original is discarded, not re-applied: the site owns src now.
    expect(el.getAttribute("src")).toBe(SITE_SRC);
    expect(el.hasAttribute(ORIG_SRC)).toBe(false);
    expect(el.hasAttribute(ORIG_SRCSET)).toBe(false);
  });

  it("ignores a plain site image that the extension never touched", () => {
    const el = img({ src: SITE_SRC });
    const h = harness(el, "");

    expect(onSiteSourceSwap(el, h.revoke)).toBe(false);
    expect(h.revoke).not.toHaveBeenCalled();
    expect(el.getAttribute("src")).toBe(SITE_SRC);
  });

  it("leaves a pending image alone because a request is in flight", () => {
    const el = img({ src: SITE_SRC, [STATE]: "pending" });
    const h = harness(el, "blob:example/in-flight");

    expect(onSiteSourceSwap(el, h.revoke)).toBe(false);
    expect(h.revoke).not.toHaveBeenCalled();
    expect(el.getAttribute(STATE)).toBe("pending");
    expect(h.blobs.has(el)).toBe(true);
  });
});

function bgDiv(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.backgroundImage = 'url("blob:https://comic.pixiv.net/page-0")';
  document.body.appendChild(el);
  return el;
}

describe("background swap/restore", () => {
  it("swap touches only background-image; sibling inline properties survive the round-trip", () => {
    // The reader keeps scroll-snap-align / direction / scroll-snap-stop in the
    // same inline style attribute; a whole-attribute rewrite would break paging.
    const el = bgDiv();
    el.style.scrollSnapAlign = "start";
    el.style.direction = "rtl";
    el.style.scrollSnapStop = "always";
    el.style.backgroundPosition = "center";

    applyBackgroundSwap(el, "blob:https://mt-extension/translation-1");
    const translated = el.style.backgroundImage;
    expect(el.getAttribute(ORIG_BG)).toBe('url("blob:https://comic.pixiv.net/page-0")');
    expect(el.style.scrollSnapAlign).toBe("start");
    expect(el.style.direction).toBe("rtl");
    expect(el.style.scrollSnapStop).toBe("always");
    expect(el.style.backgroundPosition).toBe("center center"); // jsdom serializes `center` as two axes

    restoreOriginalBackground(el);
    expect(el.style.backgroundImage).toBe('url("blob:https://comic.pixiv.net/page-0")');
    expect(el.getAttribute(HIDDEN_BG)).toBe(translated);

    reapplyTranslatedBackground(el);
    expect(el.style.backgroundImage).toBe(translated);
    expect(el.hasAttribute(HIDDEN_BG)).toBe(false);
    expect(el.style.scrollSnapAlign).toBe("start");
    expect(el.style.direction).toBe("rtl");
    expect(el.style.scrollSnapStop).toBe("always");
    expect(el.style.backgroundPosition).toBe("center center");
  });

  it("restore is a no-op without a saved original", () => {
    const el = bgDiv();
    restoreOriginalBackground(el);
    expect(el.style.backgroundImage).toBe('url("blob:https://comic.pixiv.net/page-0")');
    expect(el.hasAttribute(HIDDEN_BG)).toBe(false);
  });

  it("reapply is a no-op when nothing was stashed", () => {
    const el = bgDiv();
    reapplyTranslatedBackground(el);
    expect(el.style.backgroundImage).toBe('url("blob:https://comic.pixiv.net/page-0")');
  });

  it("takes own style writes out of the observer's set exactly once", () => {
    const el = bgDiv();
    applyBackgroundSwap(el, "blob:https://mt-extension/translation-2");
    expect(takeOwnStyleWrites().has(el)).toBe(true);
    expect(takeOwnStyleWrites().has(el)).toBe(false);
  });
});

describe("onSiteSourceSwap on a background element", () => {
  it("clears bookkeeping and revokes on a site-driven background swap", () => {
    const el = bgDiv();
    el.setAttribute(STATE, "done");
    el.setAttribute(ORIG_BG, 'url("blob:https://comic.pixiv.net/page-0")');
    const h = harness(el as unknown as HTMLImageElement, "blob:https://mt-extension/old");

    expect(onSiteSourceSwap(el, h.revoke)).toBe(true);
    expect(h.revoke).toHaveBeenCalledWith(el);
    expect(el.hasAttribute(STATE)).toBe(false);
    expect(el.hasAttribute(ORIG_BG)).toBe(false);
  });

  it("leaves an untouched background div alone", () => {
    const el = bgDiv();
    const h = harness(el as unknown as HTMLImageElement, "");

    expect(onSiteSourceSwap(el, h.revoke)).toBe(false);
    expect(h.revoke).not.toHaveBeenCalled();
  });
});
