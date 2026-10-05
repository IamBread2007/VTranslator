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
  it("keeps the requested line height when the text fits normally", () => {
    const r = fitText("xin chào bạn", { w: 100, h: 60 }, m, { minPx: 8, maxPx: 64, lineHeight: 1.2 });
    expect(r.overflow).toBe(false);
    expect(r.fontPx).toBeGreaterThanOrEqual(8);
    expect(r.lineHeight).toBe(1.2);
  });
  it("tightens line height (staying above 1.0) when minPx alone overflows", () => {
    // h=11: one line at 10px needs 12px at lineHeight 1.2, but 11px at 1.1.
    const r = fitText("xin chào bạn", { w: 100, h: 11 }, m, { minPx: 10, maxPx: 64, lineHeight: 1.2 });
    expect(r.overflow).toBe(false);
    expect(r.lineHeight).toBeLessThan(1.2);
    expect(r.lineHeight).toBeGreaterThan(1.0);
  });
  it("shrinks below minPx (but never under 8px) before flagging overflow", () => {
    // h=15: even 10px at lineHeight 1.0 needs 20px, so only a sub-minPx size fits.
    const r = fitText("xin chào bạn", { w: 100, h: 15 }, m, { minPx: 20, maxPx: 64, lineHeight: 1.2 });
    expect(r.overflow).toBe(false);
    expect(r.fontPx).toBeLessThan(20);
    expect(r.fontPx).toBeGreaterThanOrEqual(8);
  });
  it("flags overflow only when 8px at lineHeight 1.0 still cannot fit", () => {
    // One line at the absolute floor (8px, lineHeight 1.0) already exceeds h=6.
    const r = fitText("rất khó ".repeat(300), { w: 20, h: 6 }, m, { minPx: 10, maxPx: 64, lineHeight: 1.2 });
    expect(r.overflow).toBe(true);
    expect(r.fontPx).toBeGreaterThanOrEqual(8);
    expect(r.lineHeight).toBeGreaterThanOrEqual(1.0);
  });
  it("fits the reported reproduction (w=100, h=30, minPx=10) without overflow", () => {
    const r = fitText(
      "Chuyện này thật sự rất khó tin và phức tạp",
      { w: 100, h: 30 },
      m,
      { minPx: 10, maxPx: 19, lineHeight: 1.2 },
    );
    expect(r.overflow).toBe(false);
  });
});
