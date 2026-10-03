// DOM placement layer: keeps per-image chips and flash rings glued to their
// image. Pure DOM (no chrome.*) so it can be driven from tests and from any
// future caller.
//
// Why position:fixed rather than an absolutely-positioned child of the image:
// readers such as Pixiv put pages inside containers that are themselves
// position:fixed or transformed, so an ancestor-relative badge drifts to the
// corner of that container instead of staying on the image. Anchoring to the
// viewport rect and re-measuring on scroll is the one approach that survives
// every reader layout.

import { TTL_MS } from "./hudstate";

export type Corner = "top-left" | "top-right";

export interface AnchorBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface ChipOptions {
  corner?: Corner;
}

type Mode = "chip" | "cover";

interface Entry {
  el: Element;
  node: HTMLElement;
  mode: Mode;
  corner: Corner;
  timer?: number;
}

const GAP = 6;
const Z_TOP = "2147483647";

/** Position a chip beside an image rect, always keeping it fully on screen. */
export function anchorChip(
  box: AnchorBox,
  chip: Size,
  vp: Size,
  corner: Corner = "top-left",
  gap: number = GAP,
): { left: number; top: number } {
  const rawLeft = corner === "top-right" ? box.right - chip.w - gap : box.left + gap;
  const rawTop = box.top + gap;
  // The upper bound collapses to 0 for chips wider/taller than the viewport, so
  // such a chip is pinned to the origin rather than pushed to a negative offset.
  return { left: clampToViewport(rawLeft, vp.w - chip.w), top: clampToViewport(rawTop, vp.h - chip.h) };
}

function clampToViewport(pos: number, room: number): number {
  return Math.max(0, Math.min(pos, Math.max(0, room)));
}

function px(value: number): string {
  return `${Math.round(value)}px`;
}

function boxOf(rect: DOMRect): AnchorBox {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

export class OverlayLayer {
  private readonly host: HTMLElement;
  private readonly win: Window;
  private readonly entries = new Map<Element, Entry>();

  constructor(host?: HTMLElement) {
    // documentElement is the fallback for frames whose <body> has not been parsed
    // yet; without it there is nowhere to mount the chip.
    this.host = host ?? document.body ?? document.documentElement;
    const view = this.host.ownerDocument?.defaultView;
    if (!view) throw new Error("OverlayLayer host is not attached to a window");
    this.win = view;
    // Capture phase catches scroll events from the nested scrollers readers use;
    // window scroll alone only sees the document scroller.
    this.win.addEventListener("scroll", this.onLayout, { capture: true, passive: true });
    this.win.addEventListener("resize", this.onLayout);
  }

  /** Anchor a clickable chip to el. Re-setting the same el+node repositions it. */
  set(el: Element, node: HTMLElement, options: ChipOptions = {}): void {
    this.track(el, node, "chip", options.corner ?? "top-left");
  }

  /** Overlay node exactly on el's visible frame (flash ring). Never intercepts clicks. */
  cover(el: Element, node: HTMLElement): void {
    this.track(el, node, "cover", "top-left");
  }

  /** Chip that disappears after ttl, for one-shot per-image feedback. */
  flashChip(el: Element, node: HTMLElement, ttlMs: number = TTL_MS.chip): void {
    const entry = this.track(el, node, "chip", "top-left");
    // The id is read back before scheduling so a clear()/re-set cannot let an
    // older timer tear down the replacement node.
    entry.timer = this.win.setTimeout(() => {
      if (this.entries.get(el) === entry) this.clear(el);
    }, ttlMs);
  }

  clear(el: Element): void {
    const entry = this.entries.get(el);
    if (!entry) return;
    if (entry.timer !== undefined) this.win.clearTimeout(entry.timer);
    entry.node.remove();
    this.entries.delete(el);
  }

  clearAll(): void {
    for (const el of [...this.entries.keys()]) this.clear(el);
  }

  get size(): number {
    return this.entries.size;
  }

  destroy(): void {
    this.win.removeEventListener("scroll", this.onLayout, { capture: true });
    this.win.removeEventListener("resize", this.onLayout);
    this.clearAll();
  }

  private track(el: Element, node: HTMLElement, mode: Mode, corner: Corner): Entry {
    const previous = this.entries.get(el);
    if (previous) {
      if (previous.timer !== undefined) this.win.clearTimeout(previous.timer);
      if (previous.node !== node) {
        // A re-anchor of the same node must not clone it: readers re-render pages
        // and each stale duplicate would keep pointing at the old rect.
        previous.node.remove();
        this.host.appendChild(node);
      }
      this.styleFor(node, mode);
      previous.node = node;
      previous.mode = mode;
      previous.corner = corner;
      previous.timer = undefined;
      this.apply(previous);
      return previous;
    }

    this.styleFor(node, mode);
    this.host.appendChild(node);

    const entry: Entry = { el, node, mode, corner };
    this.entries.set(el, entry);
    this.apply(entry);
    return entry;
  }

  /**
   * Only geometry and stacking are set here; appearance belongs to the caller's
   * stylesheet, so several callers can share one look. Re-applied on every track
   * because a node can be re-tracked under the other mode, and a swap-in node
   * arrives with no positioning at all.
   */
  private styleFor(node: HTMLElement, mode: Mode): void {
    node.style.position = "fixed";
    node.style.zIndex = Z_TOP;
    node.style.pointerEvents = mode === "cover" ? "none" : "";
  }

  private readonly onLayout = (): void => {
    for (const entry of [...this.entries.values()]) {
      // Lazy images get replaced by the reader's own markup; a tracked element
      // that has left the document must not keep a floating chip behind.
      if (!entry.el.isConnected) this.clear(entry.el);
      else this.apply(entry);
    }
  };

  private apply(entry: Entry): void {
    const rect = entry.el.getBoundingClientRect();
    const { node } = entry;
    if (entry.mode === "cover") {
      node.style.left = px(rect.left);
      node.style.top = px(rect.top);
      // Derived from the edges rather than rect.width/height so a ring still
      // covers an element whose rect comes from a partially-filled source.
      node.style.width = px(Math.max(0, rect.right - rect.left));
      node.style.height = px(Math.max(0, rect.bottom - rect.top));
      return;
    }
    const vp: Size = { w: this.win.innerWidth, h: this.win.innerHeight };
    const chip: Size = { w: node.offsetWidth, h: node.offsetHeight };
    const pos = anchorChip(boxOf(rect), chip, vp, entry.corner);
    node.style.left = px(pos.left);
    node.style.top = px(pos.top);
  }
}
