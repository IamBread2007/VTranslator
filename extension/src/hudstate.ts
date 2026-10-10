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

export type HudKind = "idle" | "running" | "done" | "error" | "empty" | "consent" | "stop";

/**
 * Count the images this extension has touched under `root`.
 *
 * `busy` reports work the DOM cannot show yet (the queue accepted an item but
 * `data-mt-state` is only written by pump), so running must not be derived
 * from a pending image alone. Every image carrying `data-mt-state` counts into
 * `total` regardless of its value: an unrecognised state still represents
 * coverage the HUD's fraction would otherwise silently drop.
 *
 * `queued` is the number of jobs still waiting in the queue. Those images have
 * no `data-mt-state` yet, so without them the denominator only counts the one
 * job already at pump and the fraction would climb by shrinking itself.
 */
export function collectCounts(root: ParentNode, busy: boolean, queued = 0): Counts {
  let total = 0;
  let done = 0;
  let error = 0;
  let pending = false;
  // Selector is not limited to img: background-carried pages (Pixiv) carry the
  // same data-mt-state on a div.
  for (const el of root.querySelectorAll("[data-mt-state]")) {
    total++;
    const state = el.getAttribute("data-mt-state");
    if (state === "done") done++;
    else if (state === "error") error++;
    else if (state === "pending") pending = true;
  }
  return {
    total: total + queued,
    done,
    error,
    running: busy || pending || queued > 0,
  };
}

export interface HudView {
  kind: HudKind;
  text: string;
  tone: "neutral" | "ok" | "error" | "warn";
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
  if (c.running) return clampBadge(`${c.done}/${c.total}`, "#5f6368");
  if (c.error > 0) return { text: "!", color: "#b3261e" };
  if (c.done > 0) return clampBadge(String(c.done), "#1b2a4a");
  return { text: "", color: "#5f6368" };
}

// Chrome's toolbar badge truncates past four characters with no ellipsis, so a
// five-character "12/25" would render as a silent "12/2" and read as a wrong
// denominator. Four characters fit verbatim; anything longer collapses to an
// explicit "..." that signals "too big to show" instead of lying.
function clampBadge(text: string, color: string): { text: string; color: string } {
  if (text.length <= 4) return { text, color };
  return { text: "...", color: "#5f6368" };
}

/**
 * Batch progress. Separate from `Counts` because those count `data-mt-state`
 * attributes in the DOM and cannot know about pages that were discovered but
 * never mounted, never dispatched, or refused by the cap.
 */
export interface BatchView {
  /** Unique source pages seen so far. Not necessarily the whole chapter. */
  discovered: number;
  done: number;
  error: number;
  queued: number;
  /** Pages the cap refused. Non-zero is always worth saying out loud. */
  capped: number;
  coverage: "complete" | "progressive";
  eta?: string;
}

/**
 * Estimated time remaining, or undefined when there is nothing honest to show.
 *
 * Needs two successful samples because one page says nothing about the next:
 * the first request pays cold-start and cache-miss costs that later pages do
 * not, so a single sample systematically overestimates. `durations` must hold
 * only completed pages; a failed request has no page time to contribute.
 *
 * The denominator is the pages discovered so far, never a chapter total the
 * extension cannot see.
 */
export function etaFor(
  done: number,
  discovered: number,
  durations: number[],
): string | undefined {
  if (durations.length < 2) return undefined;
  const remaining = discovered - done;
  if (remaining <= 0) return undefined;
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
  const seconds = (mean * remaining) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds >= 60 ? `~${Math.round(seconds / 60)} phút` : `~${Math.round(seconds)} giây`;
}

export function summarizeBatch(v: BatchView): HudView {
  // The cap outranks completion: hitting it means work was deliberately left
  // undone, and a "done" line would claim otherwise.
  if (v.capped > 0) {
    return {
      kind: "stop",
      tone: "warn",
      text: `Đã đạt giới hạn — ${v.done} trang đã dịch, ${v.capped} trang chưa dịch. Tăng giới hạn trong tuỳ chọn nếu muốn dịch tiếp.`,
    };
  }

  const eta = v.eta ? ` — ${v.eta}` : "";
  // "đã thấy" is deliberate: until coverage is complete the denominator is what
  // discovery has seen, and presenting it as the chapter total would be a lie
  // the user acts on.
  const scope = v.coverage === "complete" ? "trang" : "trang đã thấy";
  const outstanding = v.done + v.error < v.discovered || v.queued > 0;

  if (outstanding) {
    return {
      kind: "running",
      tone: "neutral",
      text: `Đang dịch ${v.done}/${v.discovered} ${scope}${eta}…`,
    };
  }
  if (v.error > 0) {
    return { kind: "error", tone: "error", text: `⚠ ${v.error} trang lỗi — bấm để thử lại` };
  }
  if (v.done > 0) {
    return {
      kind: "done",
      tone: "ok",
      text:
        v.coverage === "complete"
          ? `✓ Đã dịch toàn bộ ${v.done}/${v.discovered} trang`
          : `✓ Đã dịch ${v.done} ${scope} — có thể còn trang chưa hiện`,
    };
  }
  return { kind: "idle", tone: "neutral", text: "" };
}

/**
 * The blocking confirmation shown before the first paid request of a batch.
 *
 * States page count and the cap, and warns that each page costs an API call.
 * It never states a price: the extension knows how many pages, never what a page
 * costs, and an invented figure would be worse than none.
 */
export function promptBatchConsent(discovered: number, cap: number): HudView {
  // The cap is always stated, not only when it binds: knowing the ceiling up
  // front is part of what the user is agreeing to.
  const capLine =
    discovered > cap
      ? ` Tối đa ${cap} trang, nên ${discovered - cap} trang sẽ không được dịch.`
      : ` Tối đa ${cap} trang.`;
  return {
    kind: "consent",
    tone: "warn",
    text: `Tìm thấy ${discovered} trang chưa dịch. Dịch tiếp? Mỗi trang là một lần gọi API và có thể phát sinh chi phí.${capLine}`,
  };
}
