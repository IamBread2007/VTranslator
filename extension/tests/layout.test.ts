import { describe, it, expect } from "vitest";
import { wrapText, fitText, type Measure } from "../src/layout";

const m: Measure = (t, px) => t.length * px * 0.5;

describe("wrapText", () => {
  it("wraps by words", () => {
    expect(wrapText("xin chào bạn nhé", 50, 10, m)).toEqual(["xin chào", "bạn nhé"]);
  });
  it("breaks a word longer than the line", () => {
    expect(wrapText("AAAAAAAAAAAA", 30, 10, m).every(l => m(l, 10) <= 30)).toBe(true);
  });
});

describe("fitText", () => {
  it("picks the largest size that fits", () => {
    const r = fitText("xin chào bạn", { w: 100, h: 60 }, m, { minPx: 8, maxPx: 64, lineHeight: 1.2 });
    const h = r.lines.length * r.fontPx * 1.2;
    expect(h).toBeLessThanOrEqual(60);
    expect(r.lines.every(l => m(l, r.fontPx) <= 100)).toBe(true);
    expect(fitText("xin chào bạn", { w: 100, h: 60 }, m, { minPx: 8, maxPx: r.fontPx + 1, lineHeight: 1.2 }).fontPx).toBe(r.fontPx);
  });
  it("never goes below minPx and flags overflow", () => {
    const r = fitText("chữ ".repeat(200), { w: 40, h: 20 }, m, { minPx: 10, maxPx: 64, lineHeight: 1.2 });
    expect(r.fontPx).toBe(10);
    expect(r.overflow).toBe(true);
  });
});
