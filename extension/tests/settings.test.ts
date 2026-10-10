import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings, saveSettings, DEFAULTS } from "../src/settings";

type Store = Record<string, unknown>;

type Area = { data: Store; getKeys: string[][]; set: (d: Store) => void };

function makeArea(): Area {
  // set() closes over `area`, which is safe: the mock body only runs when a caller invokes it.
  const area: Area = {
    data: {},
    getKeys: [],
    set: vi.fn((d: Store) => Object.assign(area.data, d)),
  };
  return area;
}

function makeChrome() {
  const sync = makeArea();
  const local = makeArea();
  const get = (area: Area) =>
    vi.fn((keys: string[]) => {
      area.getKeys.push(keys);
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

let areas: ReturnType<typeof makeChrome>;

describe("settings storage split", () => {
  beforeEach(() => {
    areas = makeChrome();
  });

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

  it("keeps an explicitly selected Brazilian Portuguese source language", async () => {
    // pt is reachable only by explicit selection (the server's script fast-path
    // cannot resolve it), so the storage layer must not narrow it back to auto.
    await chrome.storage.sync.set({ sourceLang: "pt" });
    expect((await loadSettings()).sourceLang).toBe("pt");
  });

  // Auto-translate was removed: no code path may read or write the old
  // autoSites key, so a profile that still syncs it cannot resurrect it.
  it("never touches autoSites in either storage area", async () => {
    await saveSettings({ ...DEFAULTS, token: "s3cret" });
    await loadSettings();

    const readKeys = [...areas.sync.getKeys, ...areas.local.getKeys].flat();
    expect(readKeys).not.toContain("autoSites");
    const syncWritten = vi
      .mocked(chrome.storage.sync.set)
      .mock.calls.flatMap(([data]) => Object.keys(data as Store));
    expect(syncWritten).not.toContain("autoSites");
  });

  it("ignores a stale autoSites value left by an older version", async () => {
    await chrome.storage.sync.set({ autoSites: ["example.org"] });
    const s = await loadSettings();
    expect(s).not.toHaveProperty("autoSites");
    expect(s).toEqual(DEFAULTS);
  });
});

describe("readerModes storage", () => {
  beforeEach(() => {
    areas = makeChrome();
  });

  it("round-trips a per-site reader mode through sync", async () => {
    await saveSettings({ ...DEFAULTS, readerModes: { "mangadex.org": "paged" } });
    expect((await loadSettings()).readerModes).toEqual({ "mangadex.org": "paged" });
  });

  it("drops `auto` entries so unconfigured sites stay out of the record", async () => {
    // `auto` is the default for every host; persisting it would grow the synced
    // record without changing any behaviour.
    await chrome.storage.sync.set({ readerModes: { "example.org": "auto" } });
    expect((await loadSettings()).readerModes).toEqual({});
  });

  it("discards unrecognised modes rather than widening discovery by accident", async () => {
    await chrome.storage.sync.set({ readerModes: { "example.org": "sideways" } });
    expect((await loadSettings()).readerModes).toEqual({});
  });

  it("normalises a www host so the entry still matches the reader", async () => {
    await chrome.storage.sync.set({ readerModes: { "www.mangadex.org": "paged" } });
    expect((await loadSettings()).readerModes).toEqual({ "mangadex.org": "paged" });
  });

  it("survives a readerModes value that is not an object", async () => {
    await chrome.storage.sync.set({ readerModes: "paged" });
    expect((await loadSettings()).readerModes).toEqual({});
  });
});
