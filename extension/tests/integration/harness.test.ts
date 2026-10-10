// @vitest-environment node
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { launch, type Harness } from "./harness";

let h: Harness;

beforeAll(async () => {
  h = await launch();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const dialogSel = 'dialog[data-mt-dialog="consent"]';

/**
 * Declare the fixture host a comic reader through the real Options page.
 *
 * Going through the form rather than writing chrome.storage directly keeps the
 * stored shape honest: a test that seeds storage can pass while the Options page
 * has a bug that drops the value on save.
 */
async function declareReader(modeLabel: string): Promise<void> {
  const options = await h.context.newPage();
  await options.goto(`chrome-extension://${h.extensionId}/options.html`);
  await options.locator("#newHost").fill("127.0.0.1");
  await options.locator("#newMode").selectOption({ label: modeLabel });
  await options.locator("#addMode").click();
  await options.waitForFunction(
    () => (document.getElementById("status")?.textContent ?? "").includes("Đã lưu"),
    undefined,
    { timeout: 10_000 },
  );
  await options.close();
}

describe("harness", () => {
  it("resolves the extension id from the running service worker", () => {
    // Chrome derives an unpacked extension's id from its absolute path, so the
    // value differs per machine. Reading it off the running service worker is
    // the only stable source.
    expect(h.extensionId).toMatch(/^[a-p]{32}$/);
  });

  it("loads the built extension and runs its content script in the page", async () => {
    const page = await h.context.newPage();
    await page.goto(`${h.origin}/basic.html`);
    // DOM is shared between the isolated and main worlds; window is not, so the
    // HUD pill is the observable proof that the content script initialised.
    //
    // Wait for "attached", not "visible": the pill is created hidden and stays
    // hidden while idle, so waiting for visibility would report a working
    // extension as missing.
    await page.waitForSelector("div[data-mt-hud]", { state: "attached", timeout: 15_000 });
    expect(await page.locator("div[data-mt-hud]").count()).toBe(1);
  });

  it("serves fixtures with real intrinsic dimensions", async () => {
    // Guards the trap that makes every discovery test pass or fail for the wrong
    // reason: a 1x1 bitmap looks like an icon and the minimum-edge rule drops it.
    const page = await h.context.newPage();
    await page.goto(`${h.origin}/page/800x1200.png`);
    const size = await page.evaluate(() => ({
      w: (document.querySelector("img") as HTMLImageElement).naturalWidth,
      h: (document.querySelector("img") as HTMLImageElement).naturalHeight,
    }));
    expect(size).toEqual({ w: 800, h: 1200 });
  });
});

describe("pre-flight consent", () => {
  beforeAll(async () => {
    // Without this the fixture host stays on `auto`, which deliberately scans
    // only the viewport band and would find 2 of 33 pages.
    await declareReader("Cuộn dọc — một cột dài");
  });

  it("asks before the first paid request when discovery exceeds the threshold", async () => {
    const page = await h.context.newPage();
    await page.goto(`${h.origin}/chapter-33.html`);
    await page.waitForSelector("div[data-mt-hud]", { state: "attached", timeout: 15_000 });
    expect(await page.locator("img").count()).toBe(33);

    await page.keyboard.press("Alt+t");
    await page.waitForSelector(dialogSel, { timeout: 15_000 });

    const text = (await page.locator(dialogSel).textContent()) ?? "";
    expect(text).toContain("33"); // what discovery found
    expect(text).toContain("60"); // the cap, stated up front
    // No price: the extension knows page count, never what a page costs.
    expect(text).not.toMatch(/[$€₫]\s*\d/);

    await page.locator(dialogSel).getByRole("button", { name: "Bỏ qua" }).click();
    await page.waitForSelector(dialogSel, { state: "detached", timeout: 5000 });
  });

  it("dispatches nothing at all when the user declines", async () => {
    // This is the assertion that matters: declining must leave the page exactly
    // as it was. pump() writes data-mt-state the instant it dispatches, so any
    // page carrying the attribute means a paid request was already made.
    const page = await h.context.newPage();
    await page.goto(`${h.origin}/chapter-33.html`);
    await page.waitForSelector("div[data-mt-hud]", { state: "attached", timeout: 15_000 });

    await page.keyboard.press("Alt+t");
    await page.waitForSelector(dialogSel, { timeout: 15_000 });
    await page.locator(dialogSel).getByRole("button", { name: "Bỏ qua" }).click();
    await page.waitForSelector(dialogSel, { state: "detached", timeout: 5000 });

    expect(await page.locator("[data-mt-state]").count()).toBe(0);
    expect(await page.locator("img[src^='blob:']").count()).toBe(0);
  });

  it("treats Escape as declining rather than accepting", async () => {
    // Only an explicit accept authorises spending; a dismissed dialog has not
    // said yes.
    const page = await h.context.newPage();
    await page.goto(`${h.origin}/chapter-33.html`);
    await page.waitForSelector("div[data-mt-hud]", { state: "attached", timeout: 15_000 });

    await page.keyboard.press("Alt+t");
    await page.waitForSelector(dialogSel, { timeout: 15_000 });
    await page.keyboard.press("Escape");
    await page.waitForSelector(dialogSel, { state: "detached", timeout: 5000 });

    expect(await page.locator("[data-mt-state]").count()).toBe(0);
  });

  it("does not prompt for a chapter under the threshold", async () => {
    const page = await h.context.newPage();
    await page.goto(`${h.origin}/basic.html`); // 2 pages
    await page.waitForSelector("div[data-mt-hud]", { state: "attached", timeout: 15_000 });

    await page.keyboard.press("Alt+t");
    // Dispatch is allowed to proceed here, so pages will acquire a state; what
    // must not appear is the blocking dialog.
    await page.waitForTimeout(1500);
    expect(await page.locator(dialogSel).count()).toBe(0);
  });
});