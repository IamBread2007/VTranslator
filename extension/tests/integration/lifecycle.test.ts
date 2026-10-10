// @vitest-environment node
import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import { launch, type Harness } from "./harness";
import { startStubServer, type StubServer } from "./stub-server";

let h: Harness;
let stub: StubServer;

const dialogSel = 'dialog[data-mt-dialog="consent"]';

/**
 * Record every page the extension finishes translating, in completion order.
 *
 * Injected into the main world. The DOM is shared with the content script's
 * isolated world, so a MutationObserver there sees the extension's writes even
 * though it cannot see its variables. Completion order equals dispatch order
 * because the queue is strictly sequential.
 *
 * Observing this rather than intercepting the server keeps the tests honest with
 * no reachable server: service-worker request interception silently captures
 * nothing here, which would make an ordering assertion pass on an empty array.
 */
const RECORD_COMPLETIONS = () => {
  (window as unknown as { __mtDone: string[] }).__mtDone = [];
  const record = (el: Element): void => {
    const done = (window as unknown as { __mtDone: string[] }).__mtDone;
    if (el.getAttribute("data-mt-state") === "done" && !(el as { __logged?: boolean }).__logged) {
      (el as { __logged?: boolean }).__logged = true;
      done.push(el.getAttribute("alt") ?? "unknown");
    }
  };
  // Observe `document`, not `document.documentElement`: an init script runs
  // before the parser has produced <html>, so observing the element would throw
  // and silently leave nothing attached.
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") record(r.target as Element);
      else for (const n of r.addedNodes) if (n instanceof Element) record(n);
    }
  }).observe(document, {
    attributes: true,
    attributeFilter: ["data-mt-state"],
    childList: true,
    subtree: true,
  });
};

beforeAll(async () => {
  h = await launch();
  stub = await startStubServer();
  // Point the extension at the stub through the real Options form: seeding
  // storage directly would let these tests pass while Options dropped the value.
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
  // viewport band and never finds the whole chapter.
  await options.locator("#newHost").fill("127.0.0.1");
  await options.locator("#newMode").selectOption({ label: "Cuộn dọc — một cột dài" });
  await options.locator("#addMode").click();
  await options.waitForFunction(
    () => (document.getElementById("status")?.textContent ?? "").includes("Đã lưu"),
    undefined,
    { timeout: 30_000 },
  );
  await options.close();
}, 180_000);

afterAll(async () => {
  await stub?.close();
  await h?.close();
});

let openPages: import("playwright").Page[] = [];

/**
 * Close every page a test opened.
 *
 * A page left behind keeps its batch running, so its dispatches land in the
 * next test's request log and turn an ordering assertion into a lie.
 */
afterEach(async () => {
  for (const p of openPages) await p.close().catch(() => undefined);
  openPages = [];
  stub.requests.length = 0;
});

async function newPage(): Promise<import("playwright").Page> {
  const p = await h.context.newPage();
  openPages.push(p);
  return p;
}

async function openChapter(page: import("playwright").Page, file = "chapter-33.html"): Promise<void> {
  stub.requests.length = 0;
  await page.addInitScript(RECORD_COMPLETIONS);
  await page.goto(`${h.origin}/${file}`);
  await page.waitForSelector("div[data-mt-hud]", { state: "attached", timeout: 15_000 });
}

const completed = (page: import("playwright").Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __mtDone: string[] }).__mtDone ?? []);

async function waitForCompleted(page: import("playwright").Page, n: number): Promise<void> {
  await page.waitForFunction(
    (want: number) => ((window as unknown as { __mtDone: string[] }).__mtDone ?? []).length >= want,
    n,
    { timeout: 60_000 },
  );
}

function injectPage(page: import("playwright").Page, n: number): Promise<void> {
  return page.evaluate((i: number) => {
    const img = document.createElement("img");
    img.src = `/page/${i}.png`;
    img.width = 800;
    img.height = 1200;
    img.alt = `trang ${i}`;
    document.body.appendChild(img);
  }, n);
}

describe("consent dialog lifecycle", () => {
  it("stacks only one dialog when Alt+T is pressed repeatedly", async () => {
    const page = await newPage();
    await openChapter(page);
    await page.keyboard.press("Alt+t");
    await page.waitForSelector(dialogSel, { timeout: 15_000 });
    await page.keyboard.press("Alt+t");
    await page.keyboard.press("Alt+t");
    expect(await page.locator(dialogSel).count()).toBe(1);
    await page.locator(dialogSel).getByRole("button", { name: "Bỏ qua" }).click();
  });

  it("asks again for a page mounted while the dialog was open", async () => {
    // The user approved 33 pages. A 34th mounting during the dialog must not be
    // dispatched on the strength of that approval: the dispatch-time safeguard
    // re-asks, because consent covers the pages the dialog actually showed.
    const page = await newPage();
    await openChapter(page);
    await page.keyboard.press("Alt+t");
    await page.waitForSelector(dialogSel, { timeout: 15_000 });

    await injectPage(page, 34);
    await page.locator(dialogSel).getByRole("button", { name: "Dịch tiếp" }).click();

    // The batch runs the 33 approved pages, then stops at the dialog for page 34.
    await waitForCompleted(page, 33);
    await page.waitForSelector(dialogSel, { timeout: 20_000 });
    expect(await completed(page)).not.toContain("trang 34");
    expect(stub.requests.length).toBe(33);
  });

  it("does not dispatch a page removed while the dialog was open", async () => {
    const page = await newPage();
    await openChapter(page);
    await page.keyboard.press("Alt+t");
    await page.waitForSelector(dialogSel, { timeout: 15_000 });

    await page.evaluate(() => {
      document.querySelectorAll("img")[0]?.remove();
    });
    await page.locator(dialogSel).getByRole("button", { name: "Dịch tiếp" }).click();

    await waitForCompleted(page, 20);
    expect(await completed(page)).not.toContain("trang 1");
  });

  it("completes each page exactly once, in reading order", async () => {
    // prevContext is only correct if pages are translated in reading order, and a
    // duplicate would be a second full-price translation of a page already paid
    // for.
    const page = await newPage();
    await openChapter(page);
    await page.keyboard.press("Alt+t");
    await page.waitForSelector(dialogSel, { timeout: 15_000 });
    await page.locator(dialogSel).getByRole("button", { name: "Dịch tiếp" }).click();

    await waitForCompleted(page, 33);
    const done = await completed(page);
    expect(new Set(done).size).toBe(done.length);
    expect(done).toEqual(Array.from({ length: 33 }, (_, i) => `trang ${i + 1}`));

    // The stub sees every dispatch. Duplicate pages would show up here as a
    // repeated image, and out-of-order dispatch would leave the context window
    // growing from a page the reader had not reached.
    expect(stub.requests.length).toBe(33);
    expect(new Set(stub.requests.map((r) => r.bodyBytes)).size).toBeGreaterThan(0);
  });

  it("ignores a trigger fired while the batch is already running", async () => {
    const page = await newPage();
    await openChapter(page);
    await page.keyboard.press("Alt+t");
    await page.waitForSelector(dialogSel, { timeout: 15_000 });
    await page.locator(dialogSel).getByRole("button", { name: "Dịch tiếp" }).click();

    // Hammer the shortcut while work is in flight.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Alt+t");
      await page.waitForTimeout(60);
    }
    await waitForCompleted(page, 33);
    await page.waitForTimeout(1500);

    // A competing batch would restart from page 1 and repeat work.
    const done = await completed(page);
    expect(new Set(done).size).toBe(done.length);
    expect(await page.locator(dialogSel).count()).toBe(0);
  });

  it("dispatches nothing when consent is declined as pages keep appearing", async () => {
    const page = await newPage();
    await openChapter(page);
    await page.keyboard.press("Alt+t");
    await page.waitForSelector(dialogSel, { timeout: 15_000 });

    await injectPage(page, 40);
    await injectPage(page, 41);
    await page.locator(dialogSel).getByRole("button", { name: "Bỏ qua" }).click();
    await page.waitForSelector(dialogSel, { state: "detached", timeout: 5000 });
    await page.waitForTimeout(1500);

    expect(await completed(page)).toEqual([]);
    expect(await page.locator("[data-mt-state]").count()).toBe(0);
  });
});