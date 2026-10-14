// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import {
  collectCounts,
  summarize,
  emptyView,
  badgeFor,
  etaFor,
  summarizeBatch,
  promptBatchConsent,
  TTL_MS,
  type BatchView,
  type Counts,
} from "../src/hudstate";

function counts(partial: Partial<Counts> = {}): Counts {
  return { total: 0, done: 0, error: 0, running: false, ...partial };
}

// collectCounts reads the attribute contract that imgsrc.ts owns, so the
// fixtures use the same spelling rather than a local constant.
function mkImg(state?: string): HTMLImageElement {
  const img = document.createElement("img");
  if (state !== undefined) img.setAttribute("data-mt-state", state);
  document.body.appendChild(img);
  return img;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("summarize", () => {
  it("reports progress while a request is in flight", () => {
    expect(summarize(counts({ total: 5, done: 2, running: true }))).toEqual({
      kind: "running",
      tone: "neutral",
      text: "Đang dịch 2/5 ảnh...",
    });
  });

  it("running wins over error and done", () => {
    const view = summarize(counts({ total: 6, done: 3, error: 2, running: true }));
    expect(view.kind).toBe("running");
    expect(view.text).toBe("Đang dịch 3/6 ảnh...");
  });

  it("surfaces errors for retry once nothing is running", () => {
    expect(summarize(counts({ total: 4, done: 2, error: 2 }))).toEqual({
      kind: "error",
      tone: "error",
      text: "⚠ 2 ảnh lỗi — bấm để thử lại",
    });
  });

  it("confirms a successful batch", () => {
    expect(summarize(counts({ total: 3, done: 3 }))).toEqual({
      kind: "done",
      tone: "ok",
      text: "✓ Đã dịch 3 ảnh — Alt+O: xem ảnh gốc",
    });
  });

  it("stays silent when there is nothing to report", () => {
    expect(summarize(counts())).toEqual({ kind: "idle", tone: "neutral", text: "" });
  });

  it("idle even when a total was seen but nothing finished", () => {
    expect(summarize(counts({ total: 2 }))).toEqual({ kind: "idle", tone: "neutral", text: "" });
  });
});

describe("emptyView", () => {
  it("is a standalone discovery result, not a summarised state", () => {
    expect(emptyView()).toEqual({
      kind: "empty",
      tone: "neutral",
      text: "Không có ảnh nào cần dịch",
    });
  });
});

describe("badgeFor", () => {
  it("shows progress text while running", () => {
    expect(badgeFor(counts({ total: 5, done: 1, running: true }))).toEqual({
      text: "1/5",
      color: "#5f6368",
    });
  });

  it("flags errors ahead of completed work", () => {
    expect(badgeFor(counts({ total: 5, done: 4, error: 1 }))).toEqual({
      text: "!",
      color: "#b3261e",
    });
  });

  it("counts finished images", () => {
    expect(badgeFor(counts({ total: 5, done: 5 }))).toEqual({ text: "5", color: "#1b2a4a" });
  });

  it("is blank when idle", () => {
    expect(badgeFor(counts())).toEqual({ text: "", color: "#5f6368" });
  });

  it("keeps a fraction that fits the four-character toolbar budget", () => {
    expect(badgeFor(counts({ total: 1, done: 1, running: true }))).toEqual({
      text: "1/1",
      color: "#5f6368",
    });
  });

  it("collapses a fraction wider than four characters instead of shipping a clipped badge", () => {
    // "12/25" is five characters; Chrome truncates the overflow silently.
    expect(badgeFor(counts({ total: 25, done: 12, running: true }))).toEqual({
      text: "...",
      color: "#5f6368",
    });
  });

  it("collapses a done count wider than four characters", () => {
    expect(badgeFor(counts({ total: 12345, done: 12345 }))).toEqual({
      text: "...",
      color: "#5f6368",
    });
  });

  it("never collapses the single-character error badge", () => {
    expect(badgeFor(counts({ total: 9, error: 9 }))).toEqual({ text: "!", color: "#b3261e" });
  });
});

describe("collectCounts", () => {
  it("reports no images and mirrors busy into running for an untouched page", () => {
    expect(collectCounts(document, false)).toEqual({ total: 0, done: 0, error: 0, running: false });
    expect(collectCounts(document, true)).toEqual({ total: 0, done: 0, error: 0, running: true });
  });

  it("counts each state and treats a pending image as work still running", () => {
    mkImg("done");
    mkImg("done");
    mkImg("error");
    mkImg("pending");

    expect(collectCounts(document, false)).toEqual({ total: 4, done: 2, error: 1, running: true });
  });

  it("is not running when every image has settled", () => {
    mkImg("done");
    mkImg("done");
    mkImg("error");

    expect(collectCounts(document, false)).toEqual({ total: 3, done: 2, error: 1, running: false });
  });

  it("stays running while the caller reports in-flight work even with no pending image", () => {
    mkImg("done");

    expect(collectCounts(document, true).running).toBe(true);
  });

  it("counts an image whose state is unrecognised in total only", () => {
    // A future state value must not silently disappear from the denominator.
    mkImg("skipped");

    expect(collectCounts(document, false)).toEqual({ total: 1, done: 0, error: 0, running: false });
  });

  it("ignores elements with no state attribute", () => {
    document.body.appendChild(document.createElement("img"));
    document.body.appendChild(document.createElement("div"));

    expect(collectCounts(document, false)).toEqual({ total: 0, done: 0, error: 0, running: false });
  });

  it("counts a background-page div that carries a state", () => {
    // Readers that paint pages as a background-image carry data-mt-state on
    // the div itself, so the HUD must not restrict the scan to img tags.
    const div = document.createElement("div");
    div.setAttribute("data-mt-state", "done");
    document.body.appendChild(div);

    expect(collectCounts(document, false)).toEqual({ total: 1, done: 1, error: 0, running: false });
  });

  it("scans the root it is handed, not only the document", () => {
    const section = document.createElement("section");
    document.body.appendChild(section);
    const img = document.createElement("img");
    img.setAttribute("data-mt-state", "pending");
    section.appendChild(img);

    expect(collectCounts(section, false)).toEqual({ total: 1, done: 0, error: 0, running: true });
  });

  it("counts queued-but-unmarked work into the denominator", () => {
    // pump() writes data-mt-state only when a job starts, so a batch of N
    // images spends most of its life with N-1 of them invisible to the DOM
    // scan. Without the queued count the pill would read "0/1" for a 2-image
    // page and the fraction would climb by shrinking its own denominator.
    mkImg("pending");

    expect(collectCounts(document, true, 1)).toEqual({
      total: 2,
      done: 0,
      error: 0,
      running: true,
    });
  });

  it("treats queued work as running even when no image is marked yet", () => {
    expect(collectCounts(document, false, 3)).toEqual({
      total: 3,
      done: 0,
      error: 0,
      running: true,
    });
  });

  it("defaults the queued count to zero so settled pages are unaffected", () => {
    mkImg("done");
    mkImg("done");

    expect(collectCounts(document, false)).toEqual({ total: 2, done: 2, error: 0, running: false });
    expect(collectCounts(document, false, 0)).toEqual({
      total: 2,
      done: 2,
      error: 0,
      running: false,
    });
  });
});

describe("TTL_MS", () => {
  it("matches the confirmed-state timings the HUD relies on", () => {
    expect(TTL_MS).toEqual({ done: 4000, empty: 3000, chip: 1200 });
  });
});

function view(partial: Partial<BatchView> = {}): BatchView {
  return {
    discovered: 0,
    done: 0,
    error: 0,
    queued: 0,
    capReached: false,
    coverage: "progressive",
    ...partial,
  };
}

describe("etaFor", () => {
  it("is undefined below two successful samples", () => {
    expect(etaFor(1, 10, [])).toBeUndefined();
    expect(etaFor(1, 10, [5000])).toBeUndefined();
    expect(etaFor(0, 10, [])).toBeUndefined();
  });

  it("counts only the pages still outstanding", () => {
    expect(etaFor(2, 10, [1000, 1000])).toBe("~8 giây");
    expect(etaFor(5, 10, [1000, 1000])).toBe("~5 giây");
  });

  it("switches to minutes once the estimate reaches a minute", () => {
    expect(etaFor(2, 10, [70000, 70000])).toBe("~9 phút");
  });

  it("has nothing left to estimate once every discovered page is done", () => {
    expect(etaFor(10, 10, [1000, 1000])).toBeUndefined();
  });

  it("ignores failed pages, because only successful durations are sampled", () => {
    // The caller passes durations of completed translations only, so an error
    // never drags the estimate toward a page time it never had.
    expect(etaFor(3, 10, [1000, 1000])).toBe("~7 giây");
  });
});

describe("summarizeBatch", () => {
  it("never presents a progressive total as the whole chapter", () => {
    // Review Focus #1: "5/33" alone would read as "33 is the chapter".
    const v = summarizeBatch(view({ discovered: 33, done: 5, queued: 28, eta: "~8 giây" }));
    expect(v.kind).toBe("running");
    expect(v.text).toContain("5/33");
    expect(v.text).not.toMatch(/toàn bộ|cả chương/);
    expect(v.text).toContain("~8 giây");
  });

  it("says the whole chapter only once coverage is verified complete", () => {
    const v = summarizeBatch(view({ discovered: 33, done: 33, coverage: "complete" }));
    expect(v.kind).toBe("done");
    expect(v.text).toContain("33/33");
  });

  it("stays honest when a batch finishes but coverage was never complete", () => {
    const v = summarizeBatch(view({ discovered: 30, done: 30, coverage: "progressive" }));
    expect(v.kind).toBe("done");
    expect(v.text).not.toMatch(/toàn bộ|cả chương/);
  });

  it("omits the ETA entirely when there are too few samples", () => {
    const v = summarizeBatch(view({ discovered: 33, done: 1, queued: 32 }));
    expect(v.text).not.toMatch(/~.*(giây|phút)/);
  });

  it("shows a waiting view, not running, when the queue drained with pages unmounted", () => {
    // The frozen-pill bug: nothing in flight, but discovered pages were never
    // laid out. "Đang dịch" would spin forever for work that does not exist.
    const v = summarizeBatch(view({ discovered: 5, done: 2, queued: 0, waiting: true }));
    expect(v.kind).toBe("waiting");
    expect(v.text).toContain("đang chờ trang tiếp theo");
    expect(v.text).toContain("2/5");
  });

  it("uses the zero-done wording when nothing has been translated yet", () => {
    const v = summarizeBatch(view({ discovered: 3, done: 0, queued: 0, waiting: true }));
    expect(v.kind).toBe("waiting");
    expect(v.text).toContain("Chưa dịch trang nào");
    expect(v.text).toContain("đang chờ trang tiếp theo");
  });

  it("checks waiting before outstanding, so queued work cannot mask it", () => {
    const v = summarizeBatch(view({ discovered: 5, done: 2, queued: 1, waiting: true }));
    expect(v.kind).toBe("waiting");
  });

  it("still reports running while the queue holds real work", () => {
    const v = summarizeBatch(view({ discovered: 5, done: 2, queued: 2 }));
    expect(v.kind).toBe("running");
  });

  it("reports terminal done, never waiting, once everything is settled", () => {
    const v = summarizeBatch(view({ discovered: 5, done: 5, queued: 0, coverage: "complete" }));
    expect(v.kind).toBe("done");
    expect(v.kind).not.toBe("waiting");
  });

  it("reports errors for retry once nothing is outstanding", () => {
    const v = summarizeBatch(view({ discovered: 12, done: 10, error: 2, coverage: "complete" }));
    expect(v.kind).toBe("error");
    expect(v.text).toContain("2");
  });

it("announces the cap without inventing a count of omitted pages", () => {
    // Review Focus #5: a 65-page chapter stopped at 60 must say so. It must not
    // claim "5 pages were skipped", because discovery cannot know how many
    // pages remain on a reader that has not finished mounting them.
    const v = summarizeBatch(view({ discovered: 65, done: 60, capReached: true, coverage: "complete" }));
    expect(v.text).toMatch(/giới hạn/i);
    expect(v.text).not.toMatch(/toàn bộ|cả chương/);
    expect(v.text).not.toMatch(/\d+\s*trang (chưa|bị)\s*$/);
    expect(v.text).not.toMatch(/5\s*trang/);
  });

  it("does not claim the cap when it was never reached", () => {
    const v = summarizeBatch(view({ discovered: 30, done: 30, coverage: "complete" }));
    expect(v.text).not.toMatch(/giới hạn/i);
  });

  it("stays idle when a batch never started", () => {
    expect(summarizeBatch(view()).kind).toBe("idle");
  });

  it("shows a terminal stopped summary after a user stop, never running", () => {
    const v = summarizeBatch(view({ discovered: 5, done: 1, queued: 4, stopped: "user", coverage: "complete" }));
    expect(v.kind).toBe("stop");
    expect(v.tone).toBe("neutral");
    expect(v.text.startsWith("Đã dừng")).toBe(true);
    expect(v.text).toContain("1/5");
  });

  it("reports that no page was translated when a user stop lands before any finished", () => {
    const v = summarizeBatch(view({ discovered: 5, done: 0, queued: 4, stopped: "user" }));
    expect(v.kind).toBe("stop");
    expect(v.text).toBe("Đã dừng — chưa dịch trang nào");
  });

  it("treats a declined consent as a terminal stop too", () => {
    const v = summarizeBatch(view({ discovered: 33, done: 0, stopped: "declined" }));
    expect(v.kind).toBe("stop");
    expect(v.text).toMatch(/^Đã dừng/);
  });

  it("keeps the cap message when the batch was stopped by the cap", () => {
    const v = summarizeBatch(view({ discovered: 65, done: 60, queued: 5, stopped: "capped", coverage: "complete" }));
    expect(v).toEqual({
      kind: "stop",
      tone: "warn",
      text: "Đã đạt giới hạn số trang cho phép. Tăng giới hạn trong tuỳ chọn nếu muốn dịch tiếp.",
    });
  });

  it("regression: a live batch with pages left is still running, not stopped", () => {
    const v = summarizeBatch(view({ discovered: 5, done: 1, queued: 0 }));
    expect(v.kind).toBe("running");
  });
});

describe("promptBatchConsent", () => {
  it("is a blocking warn view naming the pages found and the cap", () => {
    const v = promptBatchConsent(33, 60);
    expect(v.kind).toBe("consent");
    expect(v.tone).toBe("warn");
    expect(v.text).toContain("33");
    expect(v.text).toContain("60");
  });

  it("warns about cost without inventing a currency amount", () => {
    // The extension knows page count, never what a page costs.
    expect(promptBatchConsent(33, 60).text).not.toMatch(/[$€₫]\s*\d/);
    expect(promptBatchConsent(33, 60).text).toMatch(/API|phí|chi phí/);
  });

  it("tells the user what the cap means when discovery exceeds it", () => {
    expect(promptBatchConsent(65, 60).text).toMatch(/60/);
  });
});
