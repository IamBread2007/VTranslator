// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { scan, trackCoverage } from "../src/discovery";

const PAD = 1500;

function img(attrs: Record<string, string>): HTMLImageElement {
  const el = document.createElement("img");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

/** Places an element at a known document offset, since jsdom does no layout. */
function at(el: HTMLElement, top: number, w = 800, h = 800): HTMLElement {
  el.getBoundingClientRect = () =>
    ({
      x: 0,
      y: top,
      width: w,
      height: h,
      top,
      left: 0,
      right: w,
      bottom: top + h,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.innerHeight = 800;
});

describe("scan", () => {
  it("returns only viewport-band candidates when wholeDocument is false", () => {
    const near = at(img({ src: "/p1.jpg" }), 0);
    at(img({ src: "/p2.jpg" }), 20000);
    expect(scan(document, { wholeDocument: false, padPx: PAD, ignoredSubtrees: [] })).toEqual([near]);
  });

  it("keeps a candidate just inside the pad and drops one just outside it", () => {
    // window.innerHeight is 800, pad 1500, so the band ends at 2300.
    const inside = at(img({ src: "/edge.jpg" }), 2000);
    const outside = at(img({ src: "/past.jpg" }), 4000);
    const out = scan(document, { wholeDocument: false, padPx: PAD, ignoredSubtrees: [] });
    expect(out).toContain(inside);
    expect(out).not.toContain(outside);
  });

  it("returns every candidate when wholeDocument is true", () => {
    const near = img({ src: "/p1.jpg" });
    const far = img({ src: "/p2.jpg" });
    expect(scan(document, { wholeDocument: true, padPx: PAD, ignoredSubtrees: [] })).toEqual([near, far]);
  });

  it("keeps an unloaded lazy image that has no rendered box yet", () => {
    // The regression this guards: a scan that filtered by rendered size would
    // drop every not-yet-laid-out page, which is most of a lazy reader.
    const el = img({ src: "/lazy.jpg" }); // jsdom leaves the rect 0x0
    expect(scan(document, { wholeDocument: true, padPx: PAD, ignoredSubtrees: [] })).toEqual([el]);
  });

  it("returns candidates in DOM order, not size order", () => {
    const smallA = img({ src: "/a.jpg", width: "200", height: "200" });
    const big = img({ src: "/b.jpg", width: "1200", height: "1200" });
    const smallC = img({ src: "/c.jpg", width: "200", height: "200" });
    // A size-descending pass would yield [big, smallA, smallC].
    expect(scan(document, { wholeDocument: true, padPx: PAD, ignoredSubtrees: [] })).toEqual([smallA, big, smallC]);
  });

  it("excludes an element that is already translated", () => {
    const done = img({ src: "/done.jpg", "data-mt-state": "done" });
    const pending = img({ src: "/next.jpg" });
    const out = scan(document, { wholeDocument: true, padPx: PAD, ignoredSubtrees: [] });
    expect(out).toEqual([pending]);
    expect(out).not.toContain(done);
  });

  describe("ignoredSubtrees", () => {
    function bgDiv(bg: string): HTMLDivElement {
      const el = document.createElement("div");
      el.style.backgroundImage = bg;
      document.body.appendChild(el);
      return el;
    }

    /** Wraps an element in a comix.to comment widget, as the live DOM nests it. */
    function insideWidget(el: Element): Element {
      const widget = document.createElement("div");
      widget.className = "cm-widget";
      document.body.appendChild(widget);
      widget.appendChild(el);
      return el;
    }

    it("excludes an image inside a listed ignore-selector subtree but keeps its sibling", () => {
      const buried = insideWidget(img({ src: "/comment.jpg", width: "400", height: "300" }));
      const page = img({ src: "/page.jpg", width: "800", height: "1200" });
      const out = scan(document, { wholeDocument: true, padPx: PAD, ignoredSubtrees: [".cm-widget"] });
      expect(out).not.toContain(buried);
      expect(out).toContain(page);
    });

    it("keeps that image when the ignore list is empty", () => {
      // The unconfigured-host path: an empty list must change nothing.
      const buried = insideWidget(img({ src: "/comment.jpg", width: "400", height: "300" }));
      expect(scan(document, { wholeDocument: true, padPx: PAD, ignoredSubtrees: [] })).toContain(buried);
    });

    it("excludes a background-image candidate inside a listed ignore-selector subtree", () => {
      const buried = insideWidget(at(bgDiv('url("blob:https://comix.to/page-0")'), 0));
      // The same div is a candidate when nothing ignores it.
      expect(scan(document, { wholeDocument: true, padPx: PAD, ignoredSubtrees: [] })).toContain(buried);
      expect(scan(document, { wholeDocument: true, padPx: PAD, ignoredSubtrees: [".cm-widget"] })).not.toContain(buried);
    });
  });
});

describe("trackCoverage", () => {
  it("reports progressive until a traversal is asserted complete", () => {
    const c = trackCoverage();
    c.accept("a");
    c.accept("b");
    expect(c.state()).toBe("progressive");
  });

  it("reports complete only after finishTraversal()", () => {
    const c = trackCoverage();
    c.accept("a");
    expect(c.state()).toBe("progressive");
    c.finishTraversal();
    expect(c.state()).toBe("complete");
  });

  it("returns to progressive when a later scan accepts a new URL", () => {
    // Review Focus #1: a page found after completion must reopen coverage.
    const c = trackCoverage();
    c.accept("a");
    c.finishTraversal();
    expect(c.state()).toBe("complete");
    c.accept("b");
    expect(c.state()).toBe("progressive");
  });

  it("stays complete when a rescan re-accepts URLs it already knows", () => {
    // Rediscovery re-offers the same URLs constantly. If that reopened
    // coverage, "complete" could never persist and the HUD would flap.
    const c = trackCoverage();
    c.accept("a");
    c.accept("b");
    c.finishTraversal();
    c.accept("a");
    c.accept("b");
    expect(c.state()).toBe("complete");
  });
});