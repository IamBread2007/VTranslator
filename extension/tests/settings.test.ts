import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings, saveSettings, DEFAULTS } from "../src/settings";

type Store = Record<string, unknown>;

function makeChrome() {
  const sync: { data: Store; set: (d: Store) => void } = {
    data: {},
    set: vi.fn((d: Store) => Object.assign(sync.data, d)),
  };
  const local: { data: Store; set: (d: Store) => void } = {
    data: {},
    set: vi.fn((d: Store) => Object.assign(local.data, d)),
  };
  const get = (area: { data: Store }) => vi.fn((keys: string[]) => {
    const out: Store = {};
    for (const k of keys) if (k in area.data) out[k] = area.data[k];
    return Promise.resolve(out);
  });
  (globalThis as { chrome: typeof chrome }).chrome = {
    storage: {
      sync: { set: sync.set, get: get(sync) },
      local: { set: local.set, get: get(local) },
    },
  } as unknown as typeof chrome;
  return { sync, local };
}

describe("settings storage split", () => {
  beforeEach(() => makeChrome());

  it("token only ever lands in local, never sync", async () => {
    await saveSettings({ ...DEFAULTS, token: "s3cret" });
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ token: "s3cret" });
    const syncCalls = vi.mocked(chrome.storage.sync.set).mock.calls;
    for (const [data] of syncCalls) expect(data).not.toHaveProperty("token");
  });

  it("loadSettings merges sync + local", async () => {
    await saveSettings({ ...DEFAULTS, serverUrl: "http://127.0.0.1:8765" });
    chrome.storage.local.set({ token: "abc" });
    const s = await loadSettings();
    expect(s.serverUrl).toBe("http://127.0.0.1:8765");
    expect(s.token).toBe("abc");
    expect(s.sourceLang).toBe("auto");
  });

  it("missing values fall back to defaults", async () => {
    const s = await loadSettings();
    expect(s).toEqual(DEFAULTS);
  });
});
