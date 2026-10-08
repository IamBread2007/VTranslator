import { beforeEach, describe, expect, it, vi } from "vitest";

// The worker registers its chrome listeners at import time, so each case needs
// a fresh module registry with a freshly stubbed chrome global — otherwise the
// second import would reuse listeners bound to the previous mock.
type Listener = (...args: unknown[]) => void;

interface Harness {
  installed: Listener[];
  menuCreate: ReturnType<typeof vi.fn>;
  removeAll: ReturnType<typeof vi.fn>;
  setLastError: (e: chrome.runtime.LastError | undefined) => void;
}

async function loadWorker(): Promise<Harness> {
  const installed: Listener[] = [];
  const setLastError = (e: chrome.runtime.LastError | undefined) => {
    (chrome.runtime as { lastError?: chrome.runtime.LastError }).lastError = e;
  };
  const menuCreate = vi.fn(() => {
    // A real create() that fails sets lastError on the same tick, before the
    // caller's callback runs.
    setLastError(undefined);
  });
  const removeAll = vi.fn((cb?: () => void) => {
    setLastError(undefined);
    cb?.();
  });

  (globalThis as { chrome: unknown }).chrome = {
    runtime: {
      getURL: (p: string) => `chrome-extension://abcdefghijklmnop/${p}`,
      lastError: undefined,
      onInstalled: { addListener: (fn: Listener) => installed.push(fn) },
      onMessage: { addListener: vi.fn() },
    },
    contextMenus: {
      removeAll,
      create: menuCreate,
      onClicked: { addListener: vi.fn() },
    },
    commands: { onCommand: { addListener: vi.fn() } },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    tabs: { query: vi.fn(() => Promise.resolve([])), sendMessage: vi.fn() },
    declarativeNetRequest: { updateSessionRules: vi.fn(() => Promise.resolve()) },
  } as unknown as typeof chrome;

  vi.resetModules();
  await import("../src/background");
  return { installed, menuCreate, removeAll, setLastError };
}

describe("context menu registration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the menu when the worker installs", async () => {
    const h = await loadWorker();
    expect(h.installed).toHaveLength(1);
    h.installed[0]();
    expect(h.removeAll).toHaveBeenCalledTimes(1);
    expect(h.menuCreate).toHaveBeenCalledTimes(1);
    expect(h.menuCreate.mock.calls[0][0]).toMatchObject({
      id: "mt-translate-image",
      contexts: ["image"],
    });
  });

  it("passes a callback so lastError is read, not left unchecked", async () => {
    const h = await loadWorker();
    h.installed[0]();
    // Chrome reports "Unchecked runtime.lastError" precisely when no callback
    // reads it; a missing callback is the whole bug being guarded here.
    expect(h.menuCreate.mock.calls[0][1]).toBeTypeOf("function");
  });

  it("survives a duplicate id instead of throwing", async () => {
    const h = await loadWorker();
    h.menuCreate.mockImplementation((_opts: unknown, cb?: () => void) => {
      h.setLastError({ message: "Cannot create item with duplicate id mt-translate-image" } as chrome.runtime.LastError);
      cb?.();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() => h.installed[0]()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("duplicate id mt-translate-image"),
    );
  });

  it("stays quiet when the registration succeeds", async () => {
    const h = await loadWorker();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.installed[0]();
    expect(warn).not.toHaveBeenCalled();
  });

  it("re-registering on every install event stays harmless", async () => {
    const h = await loadWorker();
    // onInstalled fires for install, update and chrome_update, so this repeats.
    h.installed[0]();
    h.installed[0]();
    h.installed[0]();
    expect(h.removeAll).toHaveBeenCalledTimes(3);
    expect(h.menuCreate).toHaveBeenCalledTimes(3);
  });
});
