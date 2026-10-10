import type { SourceLang } from "./types";
import { narrowReaderModes, type ReaderMode } from "./sites";

// Token lives only in chrome.storage.local: sync would replicate it across
// Google-account devices. serverUrl is user-picked, not a credential.
export interface Settings {
  serverUrl: string;
  sourceLang: SourceLang;
  targetLang: string;
  token: string;
  /** hostname -> reader layout, for sites the user declared a comic reader. */
  readerModes: Record<string, ReaderMode>;
  /** Unique pages a batch may dispatch before the user is asked to confirm. */
  consentThreshold: number;
  /** Absolute ceiling on unique pages per batch. Consent can never raise it. */
  maxPages: number;
}

export const DEFAULTS: Settings = {
  serverUrl: "http://127.0.0.1:8765",
  sourceLang: "auto",
  targetLang: "vi",
  token: "",
  readerModes: {},
  consentThreshold: 10,
  maxPages: 60,
};

const SYNC_KEYS = [
  "serverUrl",
  "sourceLang",
  "targetLang",
  "readerModes",
  "consentThreshold",
  "maxPages",
] as const;
const LOCAL_KEYS = ["token"] as const;

const SOURCE_LANGS: readonly SourceLang[] = [
  "auto",
  "ja",
  "ko",
  "zh",
  "en",
  "pt",
  "es",
  "id",
];

function asStr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function asLang(v: unknown): SourceLang {
  return SOURCE_LANGS.includes(v as SourceLang) ? (v as SourceLang) : DEFAULTS.sourceLang;
}

/**
 * Coerce an untrusted stored count to a whole number of at least 1.
 *
 * Zero and negatives are rejected rather than clamped, because a threshold of 0
 * would mean "ask before every single page" and a negative cap would make the
 * batch permanently undispatchable — both silently broken states the user could
 * not diagnose from the Options page.
 */
function asPositiveInt(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1) return fallback;
  return Math.floor(v);
}

// Stored values are untrusted (user/profile may have stale shapes), so each
// field is narrowed instead of cast. Keys absent from SYNC_KEYS are dropped,
// which is what keeps a pre-existing `autoSites` entry from an older version
// from resurfacing once auto-translate was removed.
function narrow(raw: Record<string, unknown>): Settings {
  return {
    serverUrl: asStr(raw.serverUrl, DEFAULTS.serverUrl),
    sourceLang: asLang(raw.sourceLang),
    targetLang: asStr(raw.targetLang, DEFAULTS.targetLang),
    token: asStr(raw.token, DEFAULTS.token),
    readerModes: narrowReaderModes(raw.readerModes),
    consentThreshold: asPositiveInt(raw.consentThreshold, DEFAULTS.consentThreshold),
    maxPages: asPositiveInt(raw.maxPages, DEFAULTS.maxPages),
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
    readerModes: s.readerModes,
    consentThreshold: asPositiveInt(s.consentThreshold, DEFAULTS.consentThreshold),
    maxPages: asPositiveInt(s.maxPages, DEFAULTS.maxPages),
  });
  await chrome.storage.local.set({ token: s.token });
}
