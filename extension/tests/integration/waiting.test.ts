// @vitest-environment node
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { launch, type Harness } from "./harness";
import { startStubServer, type StubServer } from "./stub-server";

let h: Harness;

const stopSel = 'button[data-mt-hud]:has-text("Dừng")';

/** Wait until the stub has accepted at least `n` requests. */
async function waitForRequests(stub: StubServer, n: number, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (stub.requests.length < n) {
    if (Date.now() > deadline) {
      throw new Error(`only ${stub.requests.length}/${n} requests arrived within ${timeout}ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Answer held requests until `alt` reaches the done state, or fail.
 *
 * A held stub must be released repeatedly: answering one response lets the
 * pump dispatch the next page, which is itself held until the next round.
 */
async function settle(stub: StubServer, page: import("playwright").Page, alt: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    stub.release();
    const state = await page.locator(`img[alt="${alt}"]`).getAttribute("data-mt-state");
    if (state === "done") return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`page "${alt}" never completed`);
}

/**
 * Point the extension at `stub` through the real Options form, register the
 * vertical-scroll reader mode for the fixture origin, and open `file`.
 */
async function openFixture(stub: StubServer, file: string): Promise<import("playwright").Page> {
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
  // The status line still shows the earlier "Đã lưu", so waiting on it would
  // pass on a stale message and close the page before the mode was written.
  await options.waitForFunction(
    () => (document.querySelector("#modes")?.textContent ?? "").includes("127.0.0.1"),
    undefined,
    { timeout: 30_000 },
  );
  await options.close();

  const page = await h.context.newPage();
  await page.goto(`${h.origin}/${file}`);
  return page;
}

/**
 * Record every distinct pill view (kind and text) from now on, so a brief
 * state that polling would miss is still asserted. Written from page context
 * because the pill lives in the page's own DOM.
 */
async function recordPill(page: import("playwright").Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __mtPill: string[] }).__mtPill = seen;
    const record = (): void => {
      const hud = document.querySelector("div[data-mt-hud]");
      const kind = hud?.getAttribute("data-kind") ?? "";
      const text = (hud?.textContent ?? "").trim();
      if (!kind) return;
      const entry = `${kind}|${text}`;
      if (seen[seen.length - 1] !== entry) seen.push(entry);
    };
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });
    record();
  });
}

async function pillLog(page: import("playwright").Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __mtPill: string[] }).__mtPill ?? []);
}

/** Mount the fixture's next page and scroll, so rediscovery admits it. */
async function mountAndScroll(page: import("playwright").Page): Promise<number | null> {
  const n = await page.evaluate(() => (window as unknown as { mountNext: () => number | null }).mountNext());
  await page.evaluate(() => window.scrollBy(0, 50));
  return n;
}

beforeAll(async () => {
  h = await launch();
}, 180_000);

afterAll(async () => {
  await h?.close();
});

describe("a batch that outlives its queue", () => {
  it("keeps translating pages that mount after the trigger", async () => {
    // The reader reveals page 3 while page 1 is still in flight. The page must
    // join the live batch — same tally, same stop control — rather than falling
    // outside it into a solo run with a second count.
    const stub = await startStubServer({ hold: true });
    const page = await openFixture(stub, "waiting-mount.html");
    try {
      await recordPill(page);
      await page.keyboard.press("Alt+t");
      await waitForRequests(stub, 1);

      // The batch is genuinely mid-flight: the stop control is present.
      expect(await page.locator(stopSel).count()).toBe(1);

      expect(await mountAndScroll(page)).toBe(3);
      await settle(stub, page, "trang 3");

      const log = await pillLog(page);
      // The tally grew to include the late page, so the batch owned it.
      expect(log.some((e) => e.startsWith("running|") && e.includes("/3 trang"))).toBe(true);
      // Terminal is the honest progressive one: a page appeared after the
      // traversal, so the chapter may still have more.
      expect(log.some((e) => e.startsWith("done|") && e.includes("Đã dịch 3 trang đã thấy"))).toBe(true);
    } finally {
      stub.release();
      await page.close();
      await stub.close();
    }
  }, 120_000);

  it("waits instead of claiming completion while a page is still owed", async () => {
    // A virtualised reader unmounted page 3 before it could be dispatched.
    // The page is still owed, so the batch must say it is waiting — a "done"
    // line would read as a finished chapter, and the stop control must stay.
    const stub = await startStubServer({ hold: true });
    const page = await openFixture(stub, "waiting-mount.html");
    try {
      await recordPill(page);
      await page.keyboard.press("Alt+t");
      await waitForRequests(stub, 1);

      expect(await mountAndScroll(page)).toBe(3);
      // Give rediscovery a beat to admit page 3, then drop it the way a reader
      // that recycles nodes would.
      await page.waitForTimeout(500);
      await page.evaluate(() => (window as unknown as { unmountLast: () => string | null }).unmountLast());
      await page.waitForTimeout(500);

      // Pages 1 and 2 settle; the queue drains with page 3 still owed.
      await settle(stub, page, "trang 2");
      await page.waitForTimeout(1_000);

      const log = await pillLog(page);
      expect(log.some((e) => e.startsWith("waiting|") && e.includes("chờ trang tiếp theo"))).toBe(true);
      // No terminal claim while work is outstanding.
      expect(log.some((e) => e.includes("Đã dịch toàn bộ"))).toBe(false);

      // The batch is still alive: a page mounting now joins it and is paid for.
      expect(await page.locator(stopSel).count()).toBe(1);
      expect(await mountAndScroll(page)).toBe(4);
      await settle(stub, page, "trang 4");
    } finally {
      stub.release();
      await page.close();
      await stub.close();
    }
  }, 120_000);

  it("never admits the next chapter's pages into a stale batch", async () => {
    // An SPA navigation changes the URL without a document reload, so the
    // content script and its batch survive into the next chapter. The first
    // page of that chapter must not be tallied under the old run: the batch is
    // retired, its stop control disappears, and the page rides a fresh solo.
    const stub = await startStubServer({ hold: true });
    const page = await openFixture(stub, "basic.html");
    try {
      await recordPill(page);
      await page.keyboard.press("Alt+t");
      await waitForRequests(stub, 1);
      const beforeNav = await pillLog(page);

      // The next chapter, without a reload: the reader swaps the page
      // container the way a paged reader does.
      await page.evaluate(() => history.pushState({}, "", "/waiting-mount.html"));
      await page.evaluate(() => {
        const wrap = document.createElement("div");
        const img = document.createElement("img");
        img.src = "/page/3.png";
        img.width = 800;
        img.height = 1200;
        img.alt = "trang 3";
        wrap.appendChild(img);
        document.body.appendChild(wrap);
      });

      // The batch is retired: the held page 1 is settled and ignored as
      // stale, the batch's queued page 2 is dropped, and only the new page is
      // dispatched — under its own solo run, with no batch tally under the
      // new URL.
      await settle(stub, page, "trang 3");

      const afterNav = (await pillLog(page)).slice(beforeNav.length);
      expect(afterNav.filter((e) => e.includes("trang")).length).toBe(0);
      // The stale batch's still-queued page is abandoned with it.
      expect(await page.locator('img[alt="trang 2"]').getAttribute("data-mt-state")).not.toBe("done");
    } finally {
      stub.release();
      await page.close();
      await stub.close();
    }
  }, 120_000);
});
