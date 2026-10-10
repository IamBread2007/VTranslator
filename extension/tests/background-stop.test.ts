import { beforeEach, describe, expect, it, vi } from "vitest";

// The worker binds its chrome listeners at import time, so every case needs a
// fresh registry with a freshly stubbed chrome global.
type Listener = (...args: unknown[]) => void;

interface StopHarness {
  onMessage: Listener;
  /** Every fetch the worker attempted, in order. */
  fetches: string[];
}

/**
 * Loads the worker with a fetch that never settles, so each request stays in
 * flight long enough for a Stop to be delivered against it.
 */
async function loadWorker(): Promise<StopHarness> {
  const onMessageHolder: { fn?: Listener } = {};
  const fetches: string[] = [];

  globalThis.fetch = ((url: string, init?: RequestInit) => {
    fetches.push(String(url));
    return new Promise<Response>((_res, rej) => {
      const signal = init?.signal;
      const abort = () => rej(new DOMException("aborted", "AbortError"));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }) as unknown as typeof fetch;

  (globalThis as { chrome: unknown }).chrome = {
    runtime: {
      getURL: (p: string) => `chrome-extension://abcdefghijklmnop/${p}`,
      lastError: undefined,
      onInstalled: { addListener: vi.fn() },
      onMessage: {
        addListener: (fn: Listener) => {
          onMessageHolder.fn = fn;
        },
      },
    },
    contextMenus: {
      removeAll: vi.fn((cb?: () => void) => cb?.()),
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
    commands: { onCommand: { addListener: vi.fn() } },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    tabs: { query: vi.fn(() => Promise.resolve([])), sendMessage: vi.fn() },
    declarativeNetRequest: { updateSessionRules: vi.fn(() => Promise.resolve()) },
  } as unknown as typeof chrome;

  vi.resetModules();
  await import("../src/background");

  const fn = onMessageHolder.fn;
  if (!fn) throw new Error("onMessage listener was never registered");
  return { onMessage: fn, fetches };
}

function start(h: StopHarness, batchId: string, tabId: number, file: string) {
  const out: { value?: { error?: string; step?: string } } = {};
  h.onMessage(
    {
      type: "translate",
      url: `https://x.test/${file}`,
      pageUrl: "https://x.test/",
      prevContext: [],
      batchId,
    },
    { tab: { id: tabId } },
    (r: unknown) => {
      out.value = r as { error?: string; step?: string };
    },
  );
  return out;
}

function stop(h: StopHarness, batchId: string, tabId?: number) {
  let out: { cancelled?: number } = {};
  h.onMessage(
    { type: "mt-stop", batchId, tabId },
    {},
    (r: unknown) => {
      out = r as { cancelled?: number };
    },
  );
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("Stop is scoped to a tab and a batch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("aborts only the named batch in the named tab", async () => {
    const h = await loadWorker();
    const b1 = start(h, "B1", 7, "a.jpg");
    const b2 = start(h, "B2", 7, "b.jpg");
    await tick();

    expect(stop(h, "B1", 7).cancelled).toBe(1);
    await tick();

    // The stopped page reports "stopped", not a server failure, so the counter
    // does not show an error the user deliberately caused.
    expect(b1.value).toMatchObject({ step: "stopped" });
    // The sibling batch in the same tab is untouched and still waiting.
    expect(b2.value).toBeUndefined();
  });

  it("does not reach the server for a page stopped during its image fetch", async () => {
    const h = await loadWorker();
    const b1 = start(h, "B1", 7, "a.jpg");
    await tick();
    expect(h.fetches).toEqual(["https://x.test/a.jpg"]);

    stop(h, "B1", 7);
    await tick();

    expect(b1.value).toMatchObject({ step: "stopped" });
    // Cancelling here saves the whole request, not just the server call.
    expect(h.fetches.some((u) => u.includes("/translate"))).toBe(false);
  });

  it("stops a batch across tabs when no tab is given", async () => {
    const h = await loadWorker();
    const a = start(h, "SAME", 1, "a.jpg");
    const b = start(h, "SAME", 2, "b.jpg");
    await tick();

    expect(stop(h, "SAME").cancelled).toBe(2);
    await tick();

    expect(a.value).toMatchObject({ step: "stopped" });
    expect(b.value).toMatchObject({ step: "stopped" });
  });

  it("ignores a stop for a batch that is not running", async () => {
    const h = await loadWorker();
    expect(stop(h, "NOPE", 7).cancelled).toBe(0);
    expect(h.fetches).toHaveLength(0);
  });
});