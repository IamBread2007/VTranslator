// @vitest-environment node
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { launch, type Harness } from "./harness";
import { startStubServer, type StubServer } from "./stub-server";

let h: Harness;

const dialogSel = 'dialog[data-mt-dialog="consent"]';
const stopSel = 'button[data-mt-hud]:has-text("Dừng")';

/** Wait until the stub has accepted at least `n` requests. */
async function waitForRequests(stub: StubServer, n: number, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (stub.requests.length < n) {
    if (Date.now() > deadline) {
      throw new Error(`only ${stub.requests.length}/${n} requests arrived within ${timeout}ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  h = await launch();
}, 180_000);

afterAll(async () => {
  await h?.close();
});

/**
 * Point the extension at `stub` through the real Options form, then open the
 * 33-page chapter and approve it.
 *
 * Options is used rather than seeded storage so these tests would fail if
 * Options stopped persisting the server URL. The reader mode is registered the
 * same way, because without it `auto` scans only the viewport band and never
 * finds a whole chapter.
 */
async function approveChapter(stub: StubServer): Promise<import("playwright").Page> {
  const options = await h.context.newPage();
  await options.goto(`chrome-extension://${h.extensionId}/options.html`);
  await options.locator("#serverUrl").fill(stub.origin);
  await options.locator("#token").fill(stub.token);
  await options.locator("#form button[type=submit]").click();
  await options.waitForFunction(
    () => (document.getElementById("status")?.textContent ?? "").includes("Đã lưu"),
    undefined,
    { timeout: 30_000 },
  );
  await options.locator("#newHost").fill("127.0.0.1");
  await options.locator("#newMode").selectOption({ label: "Cuộn dọc — một cột dài" });
  await options.locator("#addMode").click();
  await options.waitForFunction(
    () => (document.getElementById("status")?.textContent ?? "").includes("Đã lưu"),
    undefined,
    { timeout: 30_000 },
  );
  await options.close();

  const page = await h.context.newPage();
  await page.goto(`${h.origin}/chapter-33.html`);
  await page.waitForSelector("div[data-mt-hud]", { state: "attached", timeout: 30_000 });

  await page.keyboard.press("Alt+t");
  await page.waitForSelector(dialogSel, { timeout: 20_000 });
  // The second press is ignored while the dialog is open, as elsewhere.
  await page.keyboard.press("Alt+t");
  await page.locator(dialogSel).getByRole("button", { name: "Dịch tiếp" }).click();
  await page.waitForSelector(stopSel, { timeout: 20_000 });
  return page;
}

describe("Stop", () => {
  it("abandons the in-flight page and starts no further ones", async () => {
    // The stub holds every response, so the first page is genuinely still being
    // translated when the user presses Stop. Without a real in-flight request
    // this could only assert that a button exists.
    const stub = await startStubServer({ hold: true });
    const page = await approveChapter(stub);
    try {
      await waitForRequests(stub, 1);
      const before = stub.requests.length;

      await page.locator(stopSel).click();
      await new Promise((r) => setTimeout(r, 2_000));

      // No further pages were dispatched after the stop...
      expect(stub.requests.length).toBe(before);
      // ...and the held request was dropped by the client, not answered.
      expect(stub.aborted.length).toBeGreaterThan(0);

      // The control disappears, because the run is over.
      await expect
        .poll(async () => page.locator(stopSel).count(), { timeout: 10_000 })
        .toBe(0);
    } finally {
      stub.release();
      await page.close();
      await stub.close();
    }
  }, 120_000);

  it("never marks a stopped page as failed", async () => {
    // A page the user deliberately cancelled must not appear in the red error
    // count; that would read as "the tool broke" rather than "you stopped it".
    const stub = await startStubServer({ hold: true });
    const page = await approveChapter(stub);
    try {
      await waitForRequests(stub, 1);
      await page.locator(stopSel).click();
      await new Promise((r) => setTimeout(r, 2_000));
      expect(await page.locator('img[data-mt-state="error"]').count()).toBe(0);
    } finally {
      stub.release();
      await page.close();
      await stub.close();
    }
  }, 120_000);
});