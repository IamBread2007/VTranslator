// Pure projection of translation progress into user-visible strings: no DOM, no
// chrome.* so the wording and priority order stay unit-testable.

export interface Counts {
  /** Images the extension has taken on or is taking on for this page. */
  total: number;
  done: number;
  error: number;
  /** True while a request is in flight or the queue still holds work. */
  running: boolean;
}

export type HudKind = "idle" | "running" | "done" | "error" | "empty";

export interface HudView {
  kind: HudKind;
  text: string;
  tone: "neutral" | "ok" | "error";
}

// How long a self-dismissing state stays up. A translation can take 12-25s per
// image, so confirmation states must outlive the user's glance at the page.
export const TTL_MS: { done: number; empty: number; chip: number } = {
  done: 4000,
  empty: 3000,
  chip: 1200,
};

export function summarize(c: Counts): HudView {
  // Progress outranks terminal states: showing "done" mid-batch would hide the
  // fact that more images are still coming.
  if (c.running) {
    return { kind: "running", tone: "neutral", text: `Đang dịch ${c.done}/${c.total} ảnh...` };
  }
  if (c.error > 0) {
    return { kind: "error", tone: "error", text: `⚠ ${c.error} ảnh lỗi — bấm để thử lại` };
  }
  if (c.done > 0) {
    return { kind: "done", tone: "ok", text: `✓ Đã dịch ${c.done} ảnh — Alt+O: xem ảnh gốc` };
  }
  // Nothing to say: a page with no work in flight must not carry any chrome.
  return { kind: "idle", tone: "neutral", text: "" };
}

/** Terminal result of a discovery pass — not derivable from Counts. */
export function emptyView(): HudView {
  return { kind: "empty", tone: "neutral", text: "Không có ảnh nào cần dịch" };
}

export function badgeFor(c: Counts): { text: string; color: string } {
  // The badge sits on a per-image anchor, so running shows the fraction that
  // finished rather than a bare count; errors win over counts because they need
  // the user's attention, and an empty string means "draw no badge at all".
  if (c.running) return { text: `${c.done}/${c.total}`, color: "#5f6368" };
  if (c.error > 0) return { text: "!", color: "#b3261e" };
  if (c.done > 0) return { text: String(c.done), color: "#1b2a4a" };
  return { text: "", color: "#5f6368" };
}
