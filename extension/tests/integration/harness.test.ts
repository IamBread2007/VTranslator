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
    // hidden while idle by design, so waiting for visibility would report a
    // working extension as missing.
    await page.waitForSelector("div[data-mt-hud]", { state: "attached", timeout: 15_000 });
    expect(await page.locator("div[data-mt-hud]").count()).toBe(1);
  });
});