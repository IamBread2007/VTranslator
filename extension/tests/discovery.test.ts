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
    expect(scan(document, { wholeDocument: false, padPx: PAD })).toEqual([near]);
  });

  it("keeps a candidate just inside the pad and drops one just outside it", () => {
    // window.innerHeight is 800, pad 1500, so the band ends at 2300.
    const inside = at(img({ src: "/edge.jpg" }), 2000);
    const outside = at(img({ src: "/past.jpg" }), 4000);
    const out = scan(document, { wholeDocument: false, padPx: PAD });
    expect(out).toContain(inside);
    expect(out).not.toContain(outside);
  });

  it("returns every candidate when wholeDocument is true", () => {
    const near = img({ src: "/p1.jpg" });
    const far = img({ src: "/p2.jpg" });
    expect(scan(document, { wholeDocument: true, padPx: PAD })).toEqual([near, far]);
  });

  it("keeps an unloaded lazy image that has no rendered box yet", () => {
    // The regression this guards: a scan that filtered by rendered size would
    // drop every not-yet-laid-out page, which is most of a lazy reader.
    const el = img({ src: "/lazy.jpg" }); // jsdom leaves the rect 0x0
    expect(scan(document, { wholeDocument: true, padPx: PAD })).toEqual([el]);
  });

  it("returns candidates in DOM order, not size order", () => {
    const smallA = img({ src: "/a.jpg", width: "200", height: "200" });
    const big = img({ src: "/b.jpg", width: "1200", height: "1200" });
    const smallC = img({ src: "/c.jpg", width: "200", height: "200" });
    // A size-descending pass would yield [big, smallA, smallC].
    expect(scan(document, { wholeDocument: true, padPx: PAD })).toEqual([smallA, big, smallC]);
  });

  it("excludes an element that is already translated", () => {
    const done = img({ src: "/done.jpg", "data-mt-state": "done" });
    const pending = img({ src: "/next.jpg" });
    const out = scan(document, { wholeDocument: true, padPx: PAD });
    expect(out).toEqual([pending]);
    expect(out).not.toContain(done);
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