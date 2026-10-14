// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHud, HUD_CSS, type Hud } from "../src/hud";
import { emptyView, TTL_MS } from "../src/hudstate";

let hud: Hud | undefined;

beforeEach(() => {
  document.body.innerHTML = "";
  hud = createHud();
});

afterEach(() => {
  hud?.destroy();
  hud = undefined;
  vi.useRealTimers();
});

function pill(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-mt-hud="1"]');
  expect(el, "pill must be in the DOM").toBeTruthy();
  return el!;
}

describe("createHud pill", () => {
  it("is an announced live region fixed to the bottom-right", () => {
    const el = pill();
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
    expect(el.getAttribute("aria-atomic")).toBe("true");
    expect(el.style.position).toBe("fixed");
    expect(el.style.right).toBe("16px");
    expect(el.style.bottom).toBe("16px");
    expect(el.style.zIndex).toBe("2147483647");
  });

  it("shows the full progress sentence while running, with a spinner", () => {
    hud!.update({ total: 5, done: 2, error: 0, running: true });
    const el = pill();
    expect(el.textContent).toBe("Đang dịch 2/5 ảnh...");
    expect(el.style.display).not.toBe("none");
    expect(el.querySelector(".mt-spin")).not.toBeNull();
  });

  it("hides the pill on idle so no chrome is left on an unrelated page", () => {
    hud!.update({ total: 5, done: 2, error: 0, running: true });
    hud!.update({ total: 0, done: 0, error: 0, running: false });
    expect(pill().style.display).toBe("none");
  });

  it("reports errors with the full retry sentence and no spinner", () => {
    hud!.update({ total: 4, done: 2, error: 2, running: false });
    const el = pill();
    expect(el.textContent).toBe("⚠ 2 ảnh lỗi — bấm để thử lại");
    expect(el.querySelector(".mt-spin")).toBeNull();
    expect(el.getAttribute("data-tone")).toBe("error");
  });

  it("confirms done without a spinner", () => {
    hud!.update({ total: 3, done: 3, error: 0, running: false });
    const el = pill();
    expect(el.textContent).toBe("✓ Đã dịch 3 ảnh — Alt+O: xem ảnh gốc");
    expect(el.querySelector(".mt-spin")).toBeNull();
  });

  it("reuses one pill element instead of stacking duplicates", () => {
    hud!.update({ total: 1, done: 0, error: 0, running: true });
    hud!.update({ total: 1, done: 1, error: 0, running: false });
    expect(document.querySelectorAll('[data-mt-hud="1"]')).toHaveLength(1);
  });
});

describe("flash", () => {
  it("shows a transient view then auto-hides after the TTL", () => {
    vi.useFakeTimers();
    hud!.flash(emptyView(), TTL_MS.empty);
    const el = pill();
    expect(el.textContent).toBe("Không có ảnh nào cần dịch");
    expect(el.style.display).not.toBe("none");
    expect(el.querySelector(".mt-spin")).not.toBeNull();

    vi.advanceTimersByTime(TTL_MS.empty + 1);
    expect(el.style.display).toBe("none");
  });

  it("cancels an older flash when a new state arrives first", () => {
    vi.useFakeTimers();
    hud!.flash(emptyView(), TTL_MS.empty);
    hud!.update({ total: 6, done: 1, error: 0, running: true });

    vi.advanceTimersByTime(TTL_MS.empty + 1);
    expect(pill().style.display).not.toBe("none");
    expect(pill().textContent).toBe("Đang dịch 1/6 ảnh...");
  });

  it("leaves no auto-hide timer running once a state replaces the flash", () => {
    vi.useFakeTimers();
    hud!.flash(emptyView(), TTL_MS.empty);
    hud!.update({ total: 0, done: 0, error: 0, running: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(pill().style.display).toBe("none");
  });

  it("an update cancels a pending auto-hide of the running chip", () => {
    vi.useFakeTimers();
    hud!.flash(emptyView(), TTL_MS.done);
    hud!.update({ total: 2, done: 2, error: 0, running: false });
    vi.advanceTimersByTime(TTL_MS.done + 1);
    expect(pill().style.display).not.toBe("none");
  });
});

describe("stop control", () => {
  it("shows a stop control while a run is in flight and fires on stop", () => {
    const cb = vi.fn();
    hud!.setStop(true, cb);
    const stop = pill().querySelector<HTMLButtonElement>(".mt-hud__stop");
    expect(stop, "stop control must be in the pill").not.toBeNull();
    stop!.click();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("removes the stop control when the run settles", () => {
    const cb = vi.fn();
    hud!.setStop(true, cb);
    hud!.setStop(false);
    expect(pill().querySelector(".mt-hud__stop")).toBeNull();
  });
});

describe("drag", () => {
  function dragBy(el: HTMLElement, dx: number, dy: number): void {
    const r = { left: 100, top: 100, right: 200, bottom: 130, width: 100, height: 30 };
    el.getBoundingClientRect = () => r as DOMRect;
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 150, clientY: 115, button: 0 }));
    document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 150 + dx, clientY: 115 + dy }));
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  }

  it("moves the pill by pointer drag without touching its content", () => {
    hud!.update({ total: 5, done: 2, error: 0, running: true });
    const el = pill();
    const textBefore = el.querySelector(".mt-hud__label")?.textContent;
    dragBy(el, 40, -30);
    expect(el.style.left).toBe("140px");
    expect(el.style.top).toBe("70px");
    expect(el.querySelector(".mt-hud__label")?.textContent).toBe(textBefore);
  });

  it("does not start a drag from the stop control", () => {
    const cb = vi.fn();
    hud!.update({ total: 5, done: 2, error: 0, running: true });
    hud!.setStop(true, cb);
    const stop = pill().querySelector<HTMLElement>(".mt-hud__stop")!;
    stop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 150, clientY: 115, button: 0 }));
    document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 300, clientY: 300 }));
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(pill().style.left).toBe("");
  });

  it("a plain click without movement is not a drag", () => {
    const cb = vi.fn();
    hud!.onRetry(cb);
    hud!.update({ total: 4, done: 2, error: 2, running: false });
    const el = pill();
    el.getBoundingClientRect = () =>
      ({ left: 100, top: 100, right: 200, bottom: 130, width: 100, height: 30 }) as DOMRect;
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 150, clientY: 115, button: 0 }));
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(el.style.left).toBe("");
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("onRetry", () => {
  it("retries once per click while an error is showing and stays visible", () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    hud!.onRetry(cb);
    hud!.update({ total: 4, done: 2, error: 2, running: false });

    pill().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(cb).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(pill().style.display).not.toBe("none");
  });

  it("ignores clicks in non-error states", () => {
    const cb = vi.fn();
    hud!.onRetry(cb);
    hud!.update({ total: 5, done: 1, error: 0, running: true });
    pill().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(cb).not.toHaveBeenCalled();
  });

  it("stops being clickable once the error clears", () => {
    const cb = vi.fn();
    hud!.onRetry(cb);
    hud!.update({ total: 4, done: 4, error: 0, running: false });
    pill().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("HUD_CSS_rules", () => {
  it("carries spinner, ring and reduced-motion rules for both injection paths", () => {
    expect(HUD_CSS).toContain("@keyframes mt-spin");
    expect(HUD_CSS).toContain("@keyframes mt-pulse");
    expect(HUD_CSS).toContain(".mt-ring");
    expect(HUD_CSS).toContain("prefers-reduced-motion");
  });

  it("styles the in-pill stop control", () => {
    expect(HUD_CSS).toContain(".mt-hud__stop");
  });

  it("injects once per document even when several pills are created", () => {
    createHud().destroy();
    createHud().destroy();
    const adopted = document.adoptedStyleSheets?.length ?? 0;
    const tags = document.querySelectorAll("style[data-mt-hud-css]").length;
    // Exactly one of the two paths may have produced a copy of the rules.
    expect(adopted + tags).toBe(1);
  });
});

describe("destroy", () => {
  it("removes the pill so nothing lingers on the page", () => {
    hud!.update({ total: 1, done: 1, error: 0, running: false });
    hud!.destroy();
    expect(document.querySelector('[data-mt-hud="1"]')).toBeNull();
    hud = undefined;
  });
});
