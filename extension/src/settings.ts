import type { SourceLang } from "./types";

// Token lives only in chrome.storage.local: sync would replicate it across
// Google-account devices. serverUrl is user-picked, not a credential.
export interface Settings {
  serverUrl: string;
  sourceLang: SourceLang;
  targetLang: string;
  autoSites: string[];
  token: string;
}

export const DEFAULTS: Settings = {
  serverUrl: "http://127.0.0.1:8765",
  sourceLang: "auto",
  targetLang: "vi",
  autoSites: [],
  token: "",
};

const SYNC_KEYS = ["serverUrl", "sourceLang", "targetLang", "autoSites"] as const;
const LOCAL_KEYS = ["token"] as const;

const SOURCE_LANGS: readonly SourceLang[] = ["auto", "ja", "ko", "zh", "en"];

function asStr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function asLang(v: unknown): SourceLang {
  return SOURCE_LANGS.includes(v as SourceLang) ? (v as SourceLang) : DEFAULTS.sourceLang;
}

function asStrList(v: unknown): string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : DEFAULTS.autoSites;
}

// Stored values are untrusted (user/profile may have stale shapes), so each
// field is narrowed instead of cast.
function narrow(raw: Record<string, unknown>): Settings {
  return {
    serverUrl: asStr(raw.serverUrl, DEFAULTS.serverUrl),
    sourceLang: asLang(raw.sourceLang),
    targetLang: asStr(raw.targetLang, DEFAULTS.targetLang),
    autoSites: asStrList(raw.autoSites),
    token: asStr(raw.token, DEFAULTS.token),
  };
}

export async function loadSettings(): Promise<Settings> {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get([...SYNC_KEYS]),
    chrome.storage.local.get([...LOCAL_KEYS]),
  ]);
  return narrow({ ...sync, ...local });
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.sync.set({
    serverUrl: s.serverUrl,
    sourceLang: s.sourceLang,
    targetLang: s.targetLang,
    autoSites: s.autoSites,
  });
  await chrome.storage.local.set({ token: s.token });
}
