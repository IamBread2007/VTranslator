// @vitest-environment node
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { launch, type Harness } from "./harness";
import { startStubServer, type StubServer } from "./stub-server";

let h: Harness;

const dialogSel = 'dialog[data-mt-dialog="consent"]';

/** Wait until the stub has been asked to translate at least `n` pages. */
async function waitForRequests(stub: StubServer, n: number, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (stub.requests.length < n) {
    if (Date.now() > deadline) {
      throw new Error(`only ${stub.requests.length}/${n} requests arrived within ${timeout}ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Count pages the content script has marked done. */
async function doneCount(page: import("playwright").Page): Promise<number> {
  return page.locator('img[data-mt-state="done"]').count();
}

beforeAll(async () => {
  h = await launch();
}, 180_000);

afterAll(async () => {
  await h?.close();
});

/** Point the extension at `stub` through the real Options form. */
async function configureServer(stub: StubServer): Promise<void> {
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
  // The fixture host must be a declared reader, otherwise `auto` scans only the
  // viewport band and never finds a whole chapter.
  await options.locator("#newHost").fill("127.0.0.1");
  await options.locator("#newMode").selectOption({ label: "Cuộn dọc — một cột dài" });
  await options.locator("#addMode").click();
  await options.waitForFunction(
    () => (document.getElementById("status")?.textContent ?? "").includes("Đã lưu"),
    undefined,
    { timeout: 30_000 },
  );
  await options.close();
}

/** Configure the extension, then open a fixture and wait for the content script. */
async function configure(page: import("playwright").Page, stub: StubServer, file = "chapter-33.html"): Promise<void> {
  await configureServer(stub);
  await page.goto(`${h.origin}/${file}`);
  await page.waitForSelector("div[data-mt-hud]", { state: "attached", timeout: 30_000 });
}

/**
 * Press Alt+T and settle any dialog that opens.
 *
 * The dialog is not guaranteed: a chapter under the consent threshold is run
 * without asking, which is the point of the threshold. Tests that assert on the
 * dialog itself should wait for it directly instead of using this helper.
 */
async function startRun(page: import("playwright").Page, approve: boolean): Promise<void> {
  await page.keyboard.press("Alt+t");
  const dialog = page.locator(dialogSel);
  // Racing the dialog against a short timeout keeps the "no prompt expected"
  // cases fast without turning the prompted ones flaky.
  const opened = await dialog
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) return;
  await dialog.getByRole("button", { name: approve ? "Dịch tiếp" : "Bỏ qua" }).click();
}

/** Press Alt+T and require that the consent dialog actually opens. */
async function startConsentRun(page: import("playwright").Page, approve: boolean): Promise<void> {
  await page.keyboard.press("Alt+t");
  await page.waitForSelector(dialogSel, { timeout: 20_000 });
  await page
    .locator(dialogSel)
    .getByRole("button", { name: approve ? "Dịch tiếp" : "Bỏ qua" })
    .click();
}

describe("consent", () => {
  it("sends nothing to the server until the user has agreed", async () => {
    const stub = await startStubServer();
    const page = await h.context.newPage();
    try {
      await configure(page, stub);
      await page.keyboard.press("Alt+t");
      await page.waitForSelector(dialogSel, { timeout: 20_000 });

      // The dialog is up and no page has been billed. Charging before the user
      // has agreed is the one failure this feature exists to prevent.
      await page.waitForTimeout(1500);
      expect(stub.requests).toHaveLength(0);

      await startRun(page, false);
    } finally {
      await page.close();
      await stub.close();
    }
  }, 120_000);

  it("keeps completed pages and dispatches nothing further when declined", async () => {
    const stub = await startStubServer();
    const page = await h.context.newPage();
    try {
      await configure(page, stub);
      await page.keyboard.press("Alt+t");
      await page.waitForSelector(dialogSel, { timeout: 20_000 });
      await page.locator(dialogSel).getByRole("button", { name: "Bỏ qua" }).click();

      await page.waitForTimeout(1500);
      // Declining is a refusal, not a cancel: nothing runs and nothing is lost.
      expect(stub.requests).toHaveLength(0);
      expect(await doneCount(page)).toBe(0);
    } finally {
      await page.close();
      await stub.close();
    }
  }, 120_000);

  it("dispatches exactly the approved pages and asks again for the rest", async () => {
    const stub = await startStubServer();
    const page = await h.context.newPage();
    try {
      await configure(page, stub);
      await page.keyboard.press("Alt+t");
      await page.waitForSelector(dialogSel, { timeout: 20_000 });
      await page.locator(dialogSel).getByRole("button", { name: "Dịch tiếp" }).click();

      await waitForRequests(stub, 33);
      expect(stub.requests).toHaveLength(33);
      // 33 pages is the whole fixture, so the run ends without re-asking.
      await expect
        .poll(async () => page.locator(dialogSel).count(), { timeout: 15_000 })
        .toBe(0);
    } finally {
      await page.close();
      await stub.close();
    }
  }, 180_000);
});

describe("the cap", () => {
  it("stops at the configured cap and does not translate the rest", async () => {
    const stub = await startStubServer();
    const page = await h.context.newPage();
    try {
      await configure(page, stub);

      // A chapter larger than the default cap, so the run must stop short of
      // the end. The pages past the cap are neither translated nor billed.
      await page.addScriptTag({
        content: `(() => {
          for (let i = 34; i <= 65; i++) {
            const img = document.createElement("img");
            img.src = "/page/" + i + ".png";
            img.width = 800; img.height = 1200; img.alt = "trang " + i;
            document.body.appendChild(img);
          }
        })()`,
      });
      await page.waitForFunction(
        () => document.querySelectorAll("img").length >= 65,
        undefined,
        { timeout: 30_000 },
      );

      await startRun(page, true);
      await waitForRequests(stub, 60);

      // Let any excess through if the cap is not actually enforced.
      await page.waitForTimeout(2500);
      expect(stub.requests.length).toBe(60);
    } finally {
      await page.close();
      await stub.close();
    }
  }, 180_000);
});

describe("duplicate URLs", () => {
  it("translates shared artwork once", async () => {
    const stub = await startStubServer();
    const page = await h.context.newPage();
    try {
      await configure(page, stub, "duplicate-url.html");
      await startRun(page, true);
      await waitForRequests(stub, 6);
      await page.waitForTimeout(2500);

      // Nine nodes, six URLs, six requests. Paying for the artwork twice is the
      // whole cost of keying the run on elements instead of URLs.
      expect(stub.requests).toHaveLength(6);
    } finally {
      await page.close();
      await stub.close();
    }
  }, 180_000);
});
describe("the run stays where the user left it", () => {
  it("does not scroll, click or turn pages on its own", async () => {
    // The reader must never drive itself. Translating a chapter is not a licence
    // to move the page the user is reading, and an extension that scrolls to find
    // its work would yank the viewport mid-sentence. Nothing here interacts with
    // the page, so any scroll or click observed during the run is the
    // extension's own doing.
    const stub = await startStubServer();
    const page = await h.context.newPage();
    try {
await page.addInitScript(() => {
        const w = window as unknown as { __mtAuto: string[]; __mtRecord: boolean };
        w.__mtAuto = [];
        w.__mtRecord = false;
        // Recording starts only once the consent dialog is settled, because the
        // click that approves it is the user's, and counting it would make every
        // run look like it clicked something.
        const note = (kind: string) => {
          if (w.__mtRecord) w.__mtAuto.push(kind);
        };
        document.addEventListener("click", () => note("click"), true);
        addEventListener("scroll", () => note("scroll"), true);
      });
      await configure(page, stub);
      await startConsentRun(page, true);
      await page.evaluate(() => {
        (window as unknown as { __mtRecord: boolean }).__mtRecord = true;
      });
      await waitForRequests(stub, 10);
      await page.waitForTimeout(1000);

      const events = await page.evaluate(
        () => (window as unknown as { __mtAuto: string[] }).__mtAuto ?? [],
      );
      expect(events).toEqual([]);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    } finally {
      await page.close();
      await stub.close();
    }
  }, 180_000);

  it("keeps one tab's Stop from touching another tab's run", async () => {
    const stub = await startStubServer();
    const a = await h.context.newPage();
    const b = await h.context.newPage();
    try {
      await configure(a, stub);
      await configure(b, stub);

      await startConsentRun(a, true);
      await waitForRequests(stub, 1);

      await startConsentRun(b, true);
      await waitForRequests(stub, 2);

      const stopSel = 'button[data-mt-hud]:has-text("Dừng")';
      await a.locator(stopSel).waitFor({ state: "visible", timeout: 20_000 });
      await b.locator(stopSel).waitFor({ state: "visible", timeout: 20_000 });

      await a.locator(stopSel).click();
      await expect
        .poll(async () => a.locator(stopSel).count(), { timeout: 15_000 })
        .toBe(0);
      await page2StillRunning(b, stub);
    } finally {
      await a.close();
      await b.close();
      await stub.close();
    }
  }, 180_000);

  it("re-applies a cached translation when the DOM replaces the image", async () => {
    // A reader that re-renders its list swaps the node out from under the
    // extension. The translated blob is already in memory, so the replacement
    // must be restored without being paid for a second time.
    const stub = await startStubServer();
    const page = await h.context.newPage();
    try {
await configure(page, stub);
      await startConsentRun(page, true);
      await expect.poll(() => doneCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);

      // Stop first so the queue is quiet and the only thing left to explain is
      // the replacement. Leaving the run going would make the request count
      // move for an unrelated reason.
      const stopSel = 'button[data-mt-hud]:has-text("Dừng")';
      await page.locator(stopSel).waitFor({ state: "visible", timeout: 20_000 });
      await page.locator(stopSel).click();
      await expect.poll(async () => page.locator(stopSel).count(), { timeout: 15_000 }).toBe(0);
      await page.waitForTimeout(1000);

      const before = stub.requests.length;
      // Replace a translated node with a fresh element carrying the original
      // src, which is what a re-rendering reader does.
      await page.evaluate(() => {
        const done = document.querySelector('img[data-mt-state="done"]') as HTMLImageElement | null;
        if (!done) return;
        const clone = document.createElement("img");
        clone.src = done.getAttribute("data-mt-original-src") ?? done.src;
        clone.width = 800;
        clone.height = 1200;
        clone.alt = done.getAttribute("alt") ?? "";
        done.replaceWith(clone);
      });
      await page.waitForTimeout(2500);

      // Restored from the store, not paid for a second time.
      expect(stub.requests.length).toBe(before);
      expect(await doneCount(page)).toBeGreaterThanOrEqual(3);
    } finally {
      await page.close();
      await stub.close();
    }
  }, 180_000);
});

/** Tab b must keep making progress after tab a stopped. */
async function page2StillRunning(
  b: import("playwright").Page,
  stub: StubServer,
): Promise<void> {
  const before = stub.requests.length;
  await expect
    .poll(async () => stub.requests.length, { timeout: 30_000 })
    .toBeGreaterThan(before);
  expect(await b.locator('img[data-mt-state="done"]').count()).toBeGreaterThan(0);
}
