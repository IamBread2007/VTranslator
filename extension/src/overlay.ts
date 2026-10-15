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
import type { Block, Box } from "./types";

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

/* ---------------- block geometry (edit mode) ---------------- */

/**
 * Scale a page-pixel box onto the client frame of the element showing that page.
 *
 * The element is rarely at 1:1 (readers fit pages to the window), so the block
 * coordinates the server sent are only usable through this mapping.
 */
export function blockRect(view: AnchorBox, page: Size, box: Box): AnchorBox {
  const sx = page.w > 0 ? (view.right - view.left) / page.w : 0;
  const sy = page.h > 0 ? (view.bottom - view.top) / page.h : 0;
  const left = view.left + box.x * sx;
  const top = view.top + box.y * sy;
  return { left, top, right: left + box.w * sx, bottom: top + box.h * sy };
}

/**
 * The block whose dialogue region covers a client point, or undefined.
 *
 * First match wins, which is enough because the detection pass already merges
 * overlapping duplicates. A point in no box opens no editor, so clicking
 * between bubbles never edits a neighbour.
 */
export function blockAt(
  view: AnchorBox,
  page: Size,
  blocks: readonly Block[],
  clientX: number,
  clientY: number,
): Block | undefined {
  for (const block of blocks) {
    const r = blockRect(view, page, block.box);
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
      return block;
    }
  }
  return undefined;
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

/* ---------------- in-place editor ---------------- */

export interface EditFrame {
  /** The block's on-screen box, which the editor covers. */
  rect: AnchorBox;
  /** The block's current translation, the editor's starting text. */
  value: string;
  /** The new text, when the user confirms. */
  onCommit: (text: string) => void;
  /** The editor was dismissed without a change. */
  onCancel?: () => void;
}

// A block box can be smaller than a usable textarea (a one-character bubble),
// so the editor is never allowed to collapse below this.
const EDIT_MIN_W = 200;
const EDIT_MIN_H = 96;

/**
 * One in-page textarea, opened over the dialogue region the user clicked.
 *
 * The translated page is a bitmap, so there is no text node to edit in place;
 * a fixed panel over the block's box lets the caller re-render the whole page
 * from the stored blocks instead, which costs no request.
 */
export class EditLayer {
  private readonly host: HTMLElement;
  private readonly win: Window;
  private editor: { node: HTMLElement; ta: HTMLTextAreaElement; frame: EditFrame } | null = null;

  constructor(host?: HTMLElement) {
    this.host = host ?? document.body ?? document.documentElement;
    const view = this.host.ownerDocument?.defaultView;
    if (!view) throw new Error("EditLayer host is not attached to a window");
    this.win = view;
  }

  get isOpen(): boolean {
    return this.editor !== null;
  }

  /** True when `node` is the editor or inside it, so the caller can shield it. */
  owns(node: EventTarget | null): boolean {
    return node instanceof Node && this.editor !== null && this.editor.node.contains(node);
  }

  /** Open the editor for a block. An editor already open is dismissed silently. */
  open(frame: EditFrame): void {
    this.close();
    const doc = this.host.ownerDocument;
    const node = doc.createElement("div");
    node.className = "mt-edit";
    node.setAttribute("data-mt-edit", "1");
    const w = Math.max(EDIT_MIN_W, Math.round(frame.rect.right - frame.rect.left));
    const h = Math.max(EDIT_MIN_H, Math.round(frame.rect.bottom - frame.rect.top));
    node.style.cssText =
      "position:fixed;z-index:2147483647;display:flex;flex-direction:column;gap:6px;" +
      "box-sizing:border-box;padding:6px;background:#fff;border:1px solid #1b2a4a;" +
      "border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.35)";
    node.style.left = px(clampToViewport(Math.round(frame.rect.left), this.win.innerWidth - w));
    node.style.top = px(clampToViewport(Math.round(frame.rect.top), this.win.innerHeight - h));
    node.style.width = px(w);
    node.style.height = px(h);

    const ta = doc.createElement("textarea");
    ta.value = frame.value;
    ta.setAttribute("aria-label", "Sửa lời thoại");
    ta.style.cssText =
      "flex:1 1 auto;width:100%;box-sizing:border-box;resize:none;border:1px solid #c7cdd8;" +
      "border-radius:6px;padding:4px 6px;font:600 14px/1.35 \"MT Be Vietnam Pro\"," +
      "\"Be Vietnam Pro\",system-ui,sans-serif;color:#1b2a4a";

    const actions = doc.createElement("div");
    actions.style.cssText = "display:flex;gap:0.5rem;justify-content:flex-end";
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Huỷ";
    const commit = doc.createElement("button");
    commit.type = "button";
    commit.textContent = "Xong";
    for (const btn of [cancel, commit]) {
      btn.style.cssText = "font:600 13px \"MT Be Vietnam Pro\",\"Be Vietnam Pro\",system-ui,sans-serif;" +
        "padding:0.3rem 0.8rem;border-radius:8px;border:1px solid #c7cdd8;background:#f3f5f9;color:#1b2a4a;cursor:pointer";
    }
    commit.style.background = "#1b2a4a";
    commit.style.color = "#fff";
    actions.append(cancel, commit);

    const finish = (accepted: boolean): void => {
      const text = ta.value;
      this.close();
      if (accepted) frame.onCommit(text);
      else frame.onCancel?.();
    };
    ta.addEventListener("keydown", (e) => {
      // Typing must not reach the page: "o"/"t" with Alt held are page
      // shortcuts, and a reader may act on Enter by paging.
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        finish(true);
      }
    });
    cancel.addEventListener("click", () => finish(false));
    commit.addEventListener("click", () => finish(true));
    // A click inside the panel must not reach the reader underneath, which
    // would page away from the image being edited.
    const swallow: EventListener = (e) => e.stopPropagation();
    for (const type of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup"]) {
      node.addEventListener(type, swallow);
    }

    node.append(ta, actions);
    this.host.appendChild(node);
    this.editor = { node, ta, frame };
    ta.focus();
    ta.select();
  }

  /** Dismiss the editor without firing either callback. */
  close(): void {
    const current = this.editor;
    if (!current) return;
    this.editor = null;
    current.node.remove();
  }

  destroy(): void {
    this.close();
  }
}
