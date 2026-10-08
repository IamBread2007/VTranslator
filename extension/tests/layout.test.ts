import { describe, it, expect } from "vitest";
import { wrapText, fitText, lineCaps, type Measure } from "../src/layout";

const m: Measure = (t, px) => t.length * px * 0.5;

/**
 * Largest fontPx that is feasible anywhere in [minPx, maxPx], found by pinning
 * the range to one size at a time. Independent of the real solver's search, so
 * it catches a search that stops short of the true maximum.
 *
 * The line height matters: the solver deliberately keeps the caller's line
 * height in preference to a larger font, tightening it only when nothing fits,
 * so the maximum is only meaningful at the line height it settled on — and only
 * sizes that fit at exactly that height count.
 */
function bruteForceMaxPx(text: string, box: { w: number; h: number }, minPx: number, maxPx: number, lineHeight: number): number {
  let best = 0;
  for (let px = minPx; px <= maxPx; px++) {
    const r = fitText(text, box, m, { minPx: px, maxPx: px, lineHeight });
    // A pinned range only proves px is achievable when the solver actually
    // picked px *and* kept this line height; otherwise it fell through to
    // shrinking the font or tightening the leading, neither of which says
    // anything about px at the requested height.
    if (!r.overflow && r.fontPx === px && r.lineHeight === lineHeight) best = px;
  }
  return best;
}

describe("wrapText", () => {
  it("wraps by words", () => {
    expect(wrapText("xin chào bạn nhé", 50, 10, m)).toEqual(["xin chào", "bạn nhé"]);
  });
  it("breaks a word longer than the line", () => {
    expect(wrapText("AAAAAAAAAAAA", 30, 10, m).every(l => m(l, 10) <= 30)).toBe(true);
  });
  it("narrows later lines when given a (lineIndex) => number profile", () => {
    const text = "aaaa bbbb cccc dddd";
    // 45 keeps two words on line 0; 25 forces one word per later line.
    const profile = (i: number) => (i === 0 ? 45 : 25);
    const number = wrapText(text, 45, 10, m);
    const ranged = wrapText(text, profile, 10, m);
    expect(ranged).toEqual(["aaaa bbbb", "cccc", "dddd"]);
    expect(number).toEqual(["aaaa bbbb", "cccc dddd"]);
    expect(ranged.slice(1).every((l, i) => m(l, 10) <= profile(i + 1))).toBe(true);
  });
  it("treats a constant-function profile exactly like the number form", () => {
    const cases = ["xin chào bạn nhé", "AAAAAAAAAAAA", "", "một hai ba bốn"];
    for (const text of cases) {
      expect(wrapText(text, () => 50, 10, m)).toEqual(wrapText(text, 50, 10, m));
    }
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

describe("fitText picks the largest size workable at its chosen line height", () => {
  it("agrees with a brute-force scan over every size", () => {
    const cases: [string, { w: number; h: number }, number, number][] = [
      ["Chuyện này thật sự rất khó tin và phức tạp", { w: 100, h: 60 }, 8, 40],
      ["xin chào bạn nhé", { w: 100, h: 60 }, 8, 40],
      ["AAAAAAAAAAAAAAAAAAAAAAAA", { w: 200, h: 200 }, 8, 60],
      ["AA BB CC DD EE FF GG HH", { w: 150, h: 90 }, 8, 40],
      ["Thật sao?", { w: 80, h: 140 }, 8, 60],
      ["Đúng vậy.", { w: 80, h: 140 }, 8, 60],
      ["chữ ".repeat(60), { w: 120, h: 120 }, 8, 30],
    ];
    for (const [text, box, minPx, maxPx] of cases) {
      const r = fitText(text, box, m, { minPx, maxPx, lineHeight: 1.2 });
      // Only compare while the text can be placed at all.
      if (r.overflow) continue;
      const brute = bruteForceMaxPx(text, box, minPx, maxPx, r.lineHeight);
      const where = `text=${JSON.stringify(text.slice(0, 24))} box=${JSON.stringify(box)} lh=${r.lineHeight}`;
      expect(r.fontPx, where).toBe(brute);
    }
  });
});

describe("balanced wrapping", () => {
  it("leaves no one-word final line where greedy fill does", () => {
    const text = "Anh không cần phải lo lắng về chuyện đó đâu";
    const box = { w: 95, h: 66 };
    const fit = fitText(text, box, m, { minPx: 8, maxPx: 64, lineHeight: 1.2 });
    expect(fit.overflow).toBe(false);
    // Compare at the size and width the balanced solver settled on, so the two
    // strategies are judged on the same budget.
    const cap = Math.max(...fit.lines.map((l) => m(l, fit.fontPx)));
    const greedy = wrapText(text, cap, fit.fontPx, m);
    const lastWords = (ls: string[]) => ls[ls.length - 1].split(" ").length;
    expect(lastWords(greedy)).toBe(1);
    expect(lastWords(fit.lines)).toBeGreaterThan(1);
  });

  it("never widens the final line past the cap to avoid a widow", () => {
    const text = "Chúng ta phải rời khỏi đây ngay lập tức";
    const fit = fitText(text, { w: 110, h: 55 }, m, { minPx: 8, maxPx: 64, lineHeight: 1.2 });
    expect(Math.max(...fit.lines.map((l) => m(l, fit.fontPx)))).toBeLessThanOrEqual(110);
  });
});

describe("hanging punctuation", () => {
  it("lets a single sentence-final mark sit outside the line width", () => {
    // "Thật sao" reserves exactly 100 at 25px, so the "?" has to hang for this
    // box to hold the text on one line.
    const withMark = fitText("Thật sao?", { w: 100, h: 60 }, m, { minPx: 8, maxPx: 64, lineHeight: 1.2 });
    expect(withMark.lines).toEqual(["Thật sao?"]);
    expect(withMark.fontPx).toBe(25);
    // Measured width does exceed the cap — that is the point of hanging.
    expect(m("Thật sao?", withMark.fontPx)).toBeGreaterThan(100);
  });

  it("hangs a trailing comma, colon or semicolon", () => {
    // Same 100px budget as the "?" case: "Thật sao" measures exactly 100 at
    // 25px, so only hanging the separator keeps the text on one line.
    for (const mark of [",", ":", ";"]) {
      const r = fitText(`Thật sao${mark}`, { w: 100, h: 60 }, m, { minPx: 8, maxPx: 64, lineHeight: 1.2 });
      expect(r.lines, mark).toEqual([`Thật sao${mark}`]);
      expect(r.fontPx, mark).toBe(25);
    }
  });

  it("does not hang a run of several marks", () => {
    // "?!" is two glyphs wide. Excluding the whole run would let the line
    // overflow by both of them, so only the final mark may hang.
    const r = fitText("Thật sao?!", { w: 100, h: 60 }, m, { minPx: 8, maxPx: 64, lineHeight: 1.2 });
    expect(r.lines).not.toEqual(["Thật sao?!"]);
    expect(Math.max(...r.lines.map((l) => m(l, r.fontPx))) - 12.5).toBeLessThanOrEqual(100);
  });
});

describe("ellipse shape", () => {
  it("narrows the profile towards the top and bottom of the box", () => {
    const caps = lineCaps({ w: 120, h: 120 }, "ellipse", 4, 18, 1.2);
    expect(caps).toHaveLength(4);
    // First and last lines are the narrowest; the two middle lines may differ
    // because an odd line box does not straddle the centre symmetrically.
    expect(caps[0]).toBeLessThan(120);
    expect(caps[3]).toBeLessThan(120);
    expect(caps[0]).toBeCloseTo(caps[3], 6);
    expect(caps[1]).toBeGreaterThan(caps[0]);
    expect(caps[2]).toBeGreaterThan(caps[3]);
  });

  it("gives every line the full box width for a rectangle", () => {
    expect(lineCaps({ w: 100, h: 60 }, "rect", 3, 12, 1.2)).toEqual([100, 100, 100]);
  });

  it("keeps every line inside its chord", () => {
    const text = "Chuyện này thật sự rất khó tin và phức tạp";
    for (const box of [{ w: 120, h: 120 }, { w: 100, h: 60 }, { w: 200, h: 80 }, { w: 80, h: 140 }]) {
      const r = fitText(text, box, m, { minPx: 8, maxPx: 64, lineHeight: 1.2, shape: "ellipse" });
      expect(r.overflow).toBe(false);
      const caps = lineCaps(box, "ellipse", r.lines.length, r.fontPx, r.lineHeight);
      r.lines.forEach((line, i) => {
        // A single trailing mark is allowed to hang past the chord.
        const kept = line.replace(/[.!?…”’]$/, "");
        expect(m(kept, r.fontPx), `line ${i} of ${JSON.stringify(box)}`).toBeLessThanOrEqual(caps[i] + 1e-9);
      });
    }
  });

  it("never chooses a larger size than the rectangle does", () => {
    const text = "Chuyện này thật sự rất khó tin và phức tạp";
    for (const box of [{ w: 120, h: 120 }, { w: 100, h: 60 }, { w: 200, h: 80 }, { w: 80, h: 140 }]) {
      const rect = fitText(text, box, m, { minPx: 8, maxPx: 64, lineHeight: 1.2, shape: "rect" });
      const ellipse = fitText(text, box, m, { minPx: 8, maxPx: 64, lineHeight: 1.2, shape: "ellipse" });
      expect(ellipse.fontPx).toBeLessThanOrEqual(rect.fontPx);
      expect(ellipse.overflow).toBe(false);
    }
  });

  it("treats an omitted shape as a rectangle", () => {
    const text = "Chuyện này thật sự rất khó tin và phức tạp";
    const box = { w: 100, h: 60 };
    const implicit = fitText(text, box, m, { minPx: 8, maxPx: 64, lineHeight: 1.2 });
    const explicit = fitText(text, box, m, { minPx: 8, maxPx: 64, lineHeight: 1.2, shape: "rect" });
    expect(implicit).toEqual(explicit);
  });
});

describe("text integrity", () => {
  it("never invents, drops or reorders characters", () => {
    // Cut pieces of one unbreakable word must rejoin with nothing between them;
    // joining them with spaces would both insert whitespace the source never had
    // and inflate the measured width, shrinking the chosen font.
    const cases: [string, { w: number; h: number }][] = [
      ["AAAAAAAAAAAAAAAAAAAAAAAA", { w: 120, h: 120 }],
      ["iiiiiiiiiiiiiiiiiiiiiiiiiiiiii", { w: 150, h: 90 }],
      ["một hai ba bốn năm sáu bảy tám chín mười", { w: 100, h: 60 }],
      ["Tôi... không hiểu?!", { w: 100, h: 60 }],
      ["chữ ".repeat(200), { w: 40, h: 20 }],
    ];
    const strip = (s: string) => s.normalize("NFC").replace(/\s+/g, "");
    for (const [text, box] of cases) {
      const r = fitText(text, box, m, { minPx: 8, maxPx: 64, lineHeight: 1.2 });
      expect(strip(r.lines.join(" ")), `text=${JSON.stringify(text.slice(0, 24))}`).toBe(strip(text));
    }
  });
});

describe("layout cost", () => {
  it("fits a long block quickly enough to run per page", () => {
    const long = "rất khó ".repeat(60);
    const started = Date.now();
    for (let i = 0; i < 100; i++) {
      fitText(long, { w: 120, h: 120 }, m, { minPx: 8, maxPx: 64, lineHeight: 1.2, shape: "ellipse" });
    }
    // Measured well under 100ms; the bound only has to catch a return to the
    // unbounded line-count search, which took seconds for a single block.
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
