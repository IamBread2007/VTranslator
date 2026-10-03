// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { anchorChip, OverlayLayer, type AnchorBox, type Size } from "../src/overlay";
import { TTL_MS } from "../src/hudstate";

const vp: Size = { w: 1000, h: 800 };
const box: AnchorBox = { left: 100, top: 120, right: 500, bottom: 420 };

describe("anchorChip", () => {
  it("pins to the top-left corner with the default gap", () => {
    expect(anchorChip(box, { w: 40, h: 16 }, vp)).toEqual({ left: 106, top: 126 });
  });

  it("pins to the top-right corner inside the box edge", () => {
    expect(anchorChip(box, { w: 40, h: 16 }, vp, "top-right")).toEqual({ left: 454, top: 126 });
  });

  it("honours a custom gap", () => {
    expect(anchorChip(box, { w: 40, h: 16 }, vp, "top-left", 20)).toEqual({ left: 120, top: 140 });
  });

  it("clamps a box scrolled off the top-left of the viewport", () => {
    const off: AnchorBox = { left: -80, top: -200, right: 40, bottom: 60 };
    expect(anchorChip(off, { w: 40, h: 16 }, vp)).toEqual({ left: 0, top: 0 });
  });

  it("clamps a chip wider than the viewport to 0 instead of a negative offset", () => {
    expect(anchorChip(box, { w: 2400, h: 16 }, vp)).toEqual({ left: 0, top: 126 });
    expect(anchorChip(box, { w: 40, h: 2000 }, vp)).toEqual({ left: 106, top: 0 });
  });

  it("keeps a top-right chip visible when the box extends past the right edge", () => {
    const wide: AnchorBox = { left: 900, top: 10, right: 1600, bottom: 200 };
    expect(anchorChip(wide, { w: 60, h: 16 }, vp, "top-right").left).toBe(940);
  });
});

function anchorable(rect: DOMRect): HTMLDivElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect);
  return el;
}

function rect(r: Partial<DOMRect>): DOMRect {
  return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}), ...r } as DOMRect;
}

describe("OverlayLayer", () => {
  let layer: OverlayLayer;

  beforeEach(() => {
    document.body.innerHTML = "";
    layer = new OverlayLayer();
  });

  afterEach(() => {
    layer.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("mounts a chip into the host as a fixed overlay", () => {
    const el = anchorable(rect({ left: 50, top: 60, right: 250, bottom: 160 }));
    const chip = document.createElement("div");
    layer.set(el, chip);

    expect(chip.parentNode).toBe(document.body);
    expect(chip.style.position).toBe("fixed");
    expect(chip.style.zIndex).toBe("2147483647");
    expect(chip.style.left).toBe("56px");
    expect(chip.style.top).toBe("66px");
    expect(layer.size).toBe(1);
  });

  it("repositions on a second set() for the same element without duplicating nodes", () => {
    const el = anchorable(rect({ left: 50, top: 60, right: 250, bottom: 160 }));
    const chip = document.createElement("div");
    layer.set(el, chip);
    vi.mocked(el.getBoundingClientRect).mockReturnValue(
      rect({ left: 300, top: 400, right: 500, bottom: 500 }),
    );

    layer.set(el, chip);

    expect(document.body.querySelectorAll("div")).toHaveLength(2); // el + the single chip
    expect(chip.style.left).toBe("306px");
    expect(chip.style.top).toBe("406px");
    expect(layer.size).toBe(1);
  });

  it("replaces the tracked node when a different node is set for the same element", () => {
    const el = anchorable(rect({ left: 10, top: 10, right: 20, bottom: 20 }));
    const first = document.createElement("div");
    const second = document.createElement("div");
    layer.set(el, first);
    layer.set(el, second);

    expect(first.isConnected).toBe(false);
    expect(second.isConnected).toBe(true);
    expect(document.body.querySelectorAll("div")).toHaveLength(2);
  });

  it("covers an element with a pointer-transparent flash ring", () => {
    const el = anchorable(rect({ left: 20, top: 30, right: 420, bottom: 530 }));
    const ring = document.createElement("div");
    layer.cover(el, ring);

    expect(ring.style.left).toBe("20px");
    expect(ring.style.top).toBe("30px");
    expect(ring.style.width).toBe("400px");
    expect(ring.style.height).toBe("500px");
    expect(ring.style.pointerEvents).toBe("none");
    expect(ring.style.position).toBe("fixed");
  });

  it("tracks the requested corner for chips", () => {
    const el = anchorable(rect({ left: 100, top: 100, right: 400, bottom: 300 }));
    const chip = document.createElement("div");
    vi.spyOn(chip, "offsetWidth", "get").mockReturnValue(30);
    vi.spyOn(chip, "offsetHeight", "get").mockReturnValue(14);
    layer.set(el, chip, { corner: "top-right" });

    expect(chip.style.left).toBe("364px");
    expect(chip.style.top).toBe("106px");
  });

  it("positions a swapped-in node and restores click-through on a mode change", () => {
    const el = anchorable(rect({ left: 10, top: 20, right: 110, bottom: 120 }));
    const ring = document.createElement("div");
    layer.cover(el, ring);
    expect(ring.style.pointerEvents).toBe("none");

    layer.set(el, ring);
    expect(ring.style.pointerEvents).toBe("");

    const chip = document.createElement("div");
    layer.cover(el, ring);
    layer.clear(el);
    layer.set(el, chip);
    expect(chip.style.position).toBe("fixed");
    expect(chip.style.zIndex).toBe("2147483647");
    expect(chip.style.left).toBe("16px");
  });

  it("clears a node and shrinks the tracked count", () => {
    const el = anchorable(rect({ left: 1, top: 2, right: 30, bottom: 40 }));
    const chip = document.createElement("div");
    layer.set(el, chip);
    layer.clear(el);

    expect(chip.isConnected).toBe(false);
    expect(layer.size).toBe(0);
  });

  it("forgets elements that leave the DOM as soon as the page scrolls", () => {
    const el = anchorable(rect({ left: 1, top: 2, right: 30, bottom: 40 }));
    const chip = document.createElement("div");
    layer.set(el, chip);
    el.remove();

    window.dispatchEvent(new Event("scroll"));

    expect(chip.isConnected).toBe(false);
    expect(layer.size).toBe(0);
  });

  it("re-anchors every tracked node on scroll and resize", () => {
    const el = anchorable(rect({ left: 50, top: 60, right: 250, bottom: 160 }));
    const chip = document.createElement("div");
    layer.set(el, chip);
    expect(chip.style.top).toBe("66px");

    vi.mocked(el.getBoundingClientRect).mockReturnValue(
      rect({ left: 50, top: 900, right: 250, bottom: 1000 }),
    );
    window.dispatchEvent(new Event("scroll"));
    // Scrolled below the fold: the chip is clamped to the bottom of the viewport
    // (jsdom measures no layout, so its height is 0 and it lands exactly on innerHeight).
    expect(chip.style.top).toBe(`${window.innerHeight}px`);

    vi.mocked(el.getBoundingClientRect).mockReturnValue(
      rect({ left: 700, top: 300, right: 900, bottom: 400 }),
    );
    window.dispatchEvent(new Event("resize"));
    expect(chip.style.left).toBe("706px");
    expect(chip.style.top).toBe("306px");
  });

  it("expires a flashed chip using the shared chip TTL", () => {
    vi.useFakeTimers();
    const el = anchorable(rect({ left: 50, top: 60, right: 250, bottom: 160 }));
    const chip = document.createElement("div");
    layer.flashChip(el, chip);

    expect(layer.size).toBe(1);
    vi.advanceTimersByTime(TTL_MS.chip + 1);
    expect(layer.size).toBe(0);
    expect(chip.isConnected).toBe(false);
  });

  it("cancels the expiry timer when the chip is cleared early", () => {
    vi.useFakeTimers();
    const el = anchorable(rect({ left: 50, top: 60, right: 250, bottom: 160 }));
    const chip = document.createElement("div");
    layer.flashChip(el, chip);
    layer.clear(el);

    vi.advanceTimersByTime(TTL_MS.chip + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clearAll drops every node and destroy detaches window listeners", () => {
    const a = anchorable(rect({ left: 1, top: 1, right: 2, bottom: 2 }));
    const b = anchorable(rect({ left: 3, top: 3, right: 4, bottom: 4 }));
    layer.set(a, document.createElement("div"));
    layer.cover(b, document.createElement("div"));
    layer.clearAll();
    expect(layer.size).toBe(0);

    const el = anchorable(rect({ left: 5, top: 5, right: 6, bottom: 6 }));
    const chip = document.createElement("div");
    layer.destroy();
    layer.set(el, chip);
    const before = chip.style.left;
    vi.mocked(el.getBoundingClientRect).mockReturnValue(rect({ left: 999, top: 999, right: 1000, bottom: 1000 }));
    window.dispatchEvent(new Event("scroll"));
    expect(chip.style.left).toBe(before);
  });
});
