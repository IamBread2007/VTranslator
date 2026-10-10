import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

const manifestPath = fileURLToPath(new URL("../manifest.json", import.meta.url));

/**
 * Loads the worker with every chrome API stubbed, returning the command listener
 * and the stub for `tabs.sendMessage`.
 */
async function loadWorker() {
  const commands: Listener[] = [];
  const sendMessage = vi.fn(() => Promise.resolve());
  const query = vi.fn(() => Promise.resolve([{ id: 12 }]));

  (globalThis as { chrome: unknown }).chrome = {
    runtime: {
      getURL: (p: string) => `chrome-extension://abcdefghijklmnop/${p}`,
      lastError: undefined,
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
    },
    contextMenus: {
      removeAll: vi.fn((cb?: () => void) => cb?.()),
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
    commands: {
      onCommand: { addListener: (fn: Listener) => commands.push(fn) },
    },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    tabs: { query, sendMessage },
    declarativeNetRequest: { updateSessionRules: vi.fn(() => Promise.resolve()) },
  } as unknown as typeof chrome;

  vi.resetModules();
  await import("../src/background");
  return { commands, sendMessage, query };
}

describe("keyboard commands", () => {
  it("binds Alt+S to stop", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      commands: Record<string, { suggested_key: { default: string } }>;
    };
    // A binding that is not declared cannot be forwarded, so this is the half
    // that a browser command test cannot observe for itself.
    expect(manifest.commands["stop-page"]?.suggested_key.default).toBe("Alt+S");
  });

  it("forwards Alt+S to the page as a stop", async () => {
    const { commands, sendMessage } = await loadWorker();
    commands[0]("stop-page");
    await new Promise((r) => setTimeout(r, 10));
    // The page owns the batch identity and the worker owns the request, so the
    // key is only useful if it reaches the content script.
    expect(sendMessage).toHaveBeenCalledWith(12, { type: "mt-stop-batch" });
  });

  it("forwards Alt+T to the page as an enqueue", async () => {
    const { commands, sendMessage } = await loadWorker();
    commands[0]("translate-page");
    await new Promise((r) => setTimeout(r, 10));
    expect(sendMessage).toHaveBeenCalledWith(12, { type: "mt-enqueue-nearby" });
  });

  it("ignores an unknown command", async () => {
    const { commands, sendMessage } = await loadWorker();
    commands[0]("something-else");
    await new Promise((r) => setTimeout(r, 10));
    expect(sendMessage).not.toHaveBeenCalled();
  });
});