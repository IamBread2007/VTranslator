// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyStored, applyStoredIn, swapIn, togglePeek } from "../src/apply";
import { TranslationStore } from "../src/store";

const PAGE = "https://reader.example/page-1.jpg";

function img(attrs: Record<string, string>): HTMLImageElement {
  const el = document.createElement("img");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

function bgDiv(bg: string): HTMLElement {
  const el = document.createElement("div");
  el.style.backgroundImage = bg;
  document.body.appendChild(el);
  return el;
}

describe("swapIn", () => {
  it("saves the site source so show-original can put it back", () => {
    const el = img({ src: PAGE });
    swapIn(el, PAGE, "blob:x");
    expect(el.getAttribute("data-mt-original-src")).toBe(PAGE);
    expect(el.getAttribute("data-mt-blob")).toBe("blob:x");
  });

  it("removes srcset and data-src so a lazy loader cannot re-override", () => {
    const el = img({ src: PAGE, srcset: "/a.jpg 800w", "data-src": "/b.jpg" });
    swapIn(el, PAGE, "blob:x");
    expect(el.hasAttribute("srcset")).toBe(false);
    expect(el.hasAttribute("data-src")).toBe(false);
  });

  it("writes only background-image on a background element", () => {
    // The same inline style carries the reader's scroll-snap settings; rewriting
    // the attribute wholesale would wipe them and break paging.
    const el = bgDiv('url("blob:site-page")');
    el.style.scrollSnapType = "y mandatory";
    swapIn(el, "blob:site-page", "blob:x");
    expect(el.style.backgroundImage).toBe('url("blob:x")');
    expect(el.style.scrollSnapType).toBe("y mandatory");
  });
});

describe("applyStored", () => {
  function storeWith(url: string, objectUrl: string): TranslationStore {
    const s = new TranslationStore();
    s.set(url, objectUrl);
    return s;
  }

  it("re-applies a page this tab already translated", () => {
    // This is the paged-reader case: the node is gone, the URL is not.
    const store = storeWith(PAGE, "blob:cached");
    const fresh = img({ src: PAGE });
    expect(applyStored(fresh, store)).toBe(true);
    expect(fresh.getAttribute("data-mt-state")).toBe("done");
    expect(fresh.getAttribute("data-mt-blob")).toBe("blob:cached");
    expect(fresh.getAttribute("data-mt-original-src")).toBe(PAGE);
  });

  it("leaves a page it has never translated alone", () => {
    const fresh = img({ src: "https://reader.example/page-2.jpg" });
    expect(applyStored(fresh, new TranslationStore())).toBe(false);
    expect(fresh.hasAttribute("data-mt-state")).toBe(false);
  });

  it("does not touch an element the extension already owns", () => {
    // pending/done/error are live states; re-applying over one would stomp a
    // translation still in flight.
    for (const state of ["pending", "done", "error"]) {
      const el = img({ src: PAGE, "data-mt-state": state });
      expect(applyStored(el, storeWith(PAGE, "blob:cached"))).toBe(false);
      expect(el.getAttribute("data-mt-blob")).toBeNull();
    }
  });

  it("does not re-apply our own blob", () => {
    // After a swap the element points at blob: and carries the saved source, so
    // resolveImageUrl refuses it — otherwise this would loop.
    const el = img({ src: "blob:cached", "data-mt-original-src": PAGE });
    expect(applyStored(el, storeWith(PAGE, "blob:cached"))).toBe(false);
  });

  it("re-applies to a background element", () => {
    const store = storeWith("blob:https://comic.pixiv.net/p1", "blob:cached");
    const el = bgDiv('url("blob:https://comic.pixiv.net/p1")');
    expect(applyStored(el, store)).toBe(true);
    expect(el.style.backgroundImage).toBe('url("blob:cached")');
  });
});

describe("applyStoredIn", () => {
  it("re-applies a page the reader mounted inside a new wrapper", () => {
    const store = new TranslationStore();
    store.set(PAGE, "blob:cached");
    const wrapper = document.createElement("div");
    const inner = document.createElement("img");
    inner.setAttribute("src", PAGE);
    wrapper.appendChild(inner);
    document.body.appendChild(wrapper);

    expect(applyStoredIn(wrapper, store)).toEqual([inner]);
    expect(inner.getAttribute("data-mt-state")).toBe("done");
  });

  it("reports nothing for a subtree with no cached page", () => {
    const wrapper = document.createElement("div");
    const inner = document.createElement("img");
    inner.setAttribute("src", "https://reader.example/other.jpg");
    wrapper.appendChild(inner);
    document.body.appendChild(wrapper);
    expect(applyStoredIn(wrapper, new TranslationStore())).toEqual([]);
  });

  it("ignores a non-element node", () => {
    expect(applyStoredIn(document.createTextNode("x"), new TranslationStore())).toEqual([]);
  });
});

describe("togglePeek", () => {
  function translatedImg(attrs: Record<string, string> = {}): { root: HTMLElement; el: HTMLImageElement } {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const el = document.createElement("img");
    el.setAttribute("src", PAGE);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    root.appendChild(el);
    swapIn(el, PAGE, "blob:translated");
    el.setAttribute("data-mt-state", "done");
    el.setAttribute("src", "blob:translated");
    return { root, el };
  }

  it("swaps translated pages back to their source while held and restores the blob on release", () => {
    const { root, el } = translatedImg();
    expect(togglePeek(true, root)).toBe(1);
    expect(el.getAttribute("src")).toBe(PAGE);
    // The bookkeeping survives the peek, which is what release restores from.
    expect(el.getAttribute("data-mt-original-src")).toBe(PAGE);
    expect(el.getAttribute("data-mt-blob")).toBe("blob:translated");

    expect(togglePeek(false, root)).toBe(1);
    expect(el.getAttribute("src")).toBe("blob:translated");
  });

  it("a repeated hold is a no-op, so the blob the release needs is never dropped", () => {
    const { root, el } = translatedImg();
    togglePeek(true, root);
    expect(togglePeek(true, root)).toBe(0);
    expect(togglePeek(false, root)).toBe(1);
    expect(el.getAttribute("src")).toBe("blob:translated");
  });

  it("restores the site's srcset on peek and removes it again so the blob wins", () => {
    const { root, el } = translatedImg({ srcset: "/a.jpg 800w, /b.jpg 1600w" });
    // swapIn already stripped srcset from the element; the site's set is saved.
    expect(el.hasAttribute("srcset")).toBe(false);
    togglePeek(true, root);
    expect(el.getAttribute("srcset")).toBe("/a.jpg 800w, /b.jpg 1600w");
    togglePeek(false, root);
    expect(el.hasAttribute("srcset")).toBe(false);
    expect(el.getAttribute("src")).toBe("blob:translated");
  });

  it("peeks a background-carried page through its saved background", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const el = document.createElement("div");
    el.style.backgroundImage = 'url("blob:site-page")';
    root.appendChild(el);
    swapIn(el, "blob:site-page", "blob:translated");
    el.setAttribute("data-mt-state", "done");

    expect(togglePeek(true, root)).toBe(1);
    expect(el.style.backgroundImage).toBe('url("blob:site-page")');
    expect(togglePeek(false, root)).toBe(1);
    expect(el.style.backgroundImage).toBe('url("blob:translated")');
  });

  it("an edit re-swap of a background page does not lose the original it peeks to", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const el = document.createElement("div");
    el.style.backgroundImage = 'url("blob:site-page")';
    root.appendChild(el);
    swapIn(el, "blob:site-page", "blob:first");
    el.setAttribute("data-mt-state", "done");

    // The in-place edit path: the same element gets a freshly composed blob.
    swapIn(el, "blob:site-page", "blob:edited");

    togglePeek(true, root);
    expect(el.style.backgroundImage).toBe('url("blob:site-page")');
    togglePeek(false, root);
    expect(el.style.backgroundImage).toBe('url("blob:edited")');
  });

  it("reports zero when nothing under the root was translated", () => {
    expect(togglePeek(true, document.createElement("div"))).toBe(0);
  });
});