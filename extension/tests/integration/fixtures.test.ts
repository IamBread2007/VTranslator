// @vitest-environment node
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { launch, type Harness } from "./harness";

let h: Harness;

/** Load a fixture and wait for the content script to attach to it. */
async function open(file: string): Promise<import("playwright").Page> {
  const page = await h.context.newPage();
  await page.goto(`${h.origin}/${file}`);
  await page.waitForSelector("div[data-mt-hud]", { state: "attached", timeout: 30_000 });
  return page;
}

/**
 * These cases pin the fixtures themselves: each reader has to present a known,
 * countable shape before any test can say anything about what the extension does
 * with it. What the extension *dispatches* is asserted against the stub server in
 * lifecycle.test.ts and suite.ts, where a real request proves it.
 */
describe("fixture readers", () => {
  beforeAll(async () => {
    h = await launch();
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  });

  it("long-strip: one column, with a banner and a portrait page among the rest", async () => {
    const page = await open("long-strip.html");
    try {
      const imgs = await page.locator("img").count();
      expect(imgs).toBe(33);

      // The two boundary cases the 3:1 rule has to separate correctly.
      const banner = await page.locator('img[width="1200"][height="300"]').count();
      const portrait = await page.locator('img[width="367"][height="640"]').count();
      expect(banner).toBe(1);
      expect(portrait).toBe(1);

      // One column: every page shares the same horizontal offset.
      const tops = await page.$$eval("img", (els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
      expect(new Set(tops).size).toBe(1);
    } finally {
      await page.close();
    }
  }, 120_000);

  it("horizontal-slide: pages sit side by side in one row", async () => {
    const page = await open("horizontal-slide.html");
    try {
      expect(await page.locator("#strip img").count()).toBe(30);
      const lefts = await page.$$eval("#strip img", (els) => els.map((e) => e.getBoundingClientRect().left));
      // Distinct offsets in increasing order is what makes this a slide reader
      // rather than a scroll reader wearing the same markup.
      expect(new Set(lefts).size).toBe(30);
      for (let i = 1; i < lefts.length; i++) expect(lefts[i]).toBeGreaterThan(lefts[i - 1]);
    } finally {
      await page.close();
    }
  }, 120_000);

  it("lazy-mount: pages appear only once the reader scrolls", async () => {
    const page = await open("lazy-mount.html");
    try {
      const count = () => page.locator("#pages img").count();
      const before = await count();
      expect(before).toBeLessThan(20); // not everything is mounted up front

      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(150);
      }
      await page.waitForFunction(
        () => document.querySelectorAll("#pages img").length > 0,
        undefined,
        { timeout: 15_000 },
      );
      expect(await count()).toBeGreaterThan(before);
    } finally {
      await page.close();
    }
  }, 120_000);

  it("duplicate-url: several nodes, one artwork each", async () => {
    const page = await open("duplicate-url.html");
    try {
      const srcs = await page.$$eval("img", (els) => els.map((e) => e.getAttribute("src")));
      expect(srcs.length).toBe(9);
      // Six distinct URLs across nine nodes: the shape that makes a run bill the
      // same artwork more than once if it keys on elements instead of URLs.
      expect(new Set(srcs).size).toBe(6);
    } finally {
      await page.close();
    }
  }, 120_000);

  it("paged-swap: the reader advances by rewriting one node", async () => {
    const page = await open("paged-swap.html");
    try {
      expect(await page.locator("img").count()).toBe(1);
      const src = () => page.locator("#stage").getAttribute("src");
      expect(await src()).toBe("/page/1.png");

      await page.evaluate(() => (window as unknown as { turn: () => number }).turn());
      expect(await src()).toBe("/page/2.png");
      await page.evaluate(() => (window as unknown as { turn: () => number }).turn());
      expect(await src()).toBe("/page/3.png");
      // Still one node: per-element bookkeeping cannot track this reader.
      expect(await page.locator("img").count()).toBe(1);
    } finally {
      await page.close();
    }
  }, 120_000);

  it("background-pages: artwork with no img element at all", async () => {
    const page = await open("background-pages.html");
    try {
      expect(await page.locator("img").count()).toBe(0);
      const bgs = await page.$$eval(".page", (els) => els.map((e) => getComputedStyle(e).backgroundImage));
      expect(bgs.filter((b) => b && b !== "none").length).toBe(5);
    } finally {
      await page.close();
    }
  }, 120_000);
});