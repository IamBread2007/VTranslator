import { describe, it, expect } from "vitest";
import { summarize, emptyView, badgeFor, TTL_MS, type Counts } from "../src/hudstate";

function counts(partial: Partial<Counts> = {}): Counts {
  return { total: 0, done: 0, error: 0, running: false, ...partial };
}

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
});

describe("TTL_MS", () => {
  it("matches the confirmed-state timings the HUD relies on", () => {
    expect(TTL_MS).toEqual({ done: 4000, empty: 3000, chip: 1200 });
  });
});
