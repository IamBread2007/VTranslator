import { describe, it, expect } from "vitest";
import { fontBounds } from "../src/render";
import type { Block } from "../src/types";

function block(h: number, fontPx: number): Block {
  return {
    id: 1,
    box: { x: 0, y: 0, w: 100, h },
    render_box: { x: 0, y: 0, w: 100, h },
    kind: "text_bubble",
    source: "",
    translation: "",
    style: {
      color: "#000000",
      stroke_color: "#ffffff",
      stroke_width: 0,
      font_px: fontPx,
      font: "dialogue",
    },
  };
}

describe("fontBounds", () => {
  it("treats font_px as hint, not cap: hinted max wins over geometry", () => {
    // h=120 → geometric 96; hint 72 → hintedMax 115 → max 115 (>72).
    expect(fontBounds(block(120, 72)).maxPx).toBe(115);
  });
  it("tall bubbles use geometry and cap at 180px", () => {
    expect(fontBounds(block(1000, 72)).maxPx).toBe(180);
  });
  it("tiny boxes still get a readable minPx floor", () => {
    expect(fontBounds(block(40, 12)).minPx).toBe(10);
    expect(fontBounds(block(300, 12)).minPx).toBe(18);
  });
});
