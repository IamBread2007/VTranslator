// Per-site reader layout.
//
// A comic reader arranges its pages in one of a few shapes, and that shape — not
// the site — decides how many pages a single Alt+T can reach. MangaDex's Long
// Strip stacks 13+ pages down ~10,000px, so a viewport-sized window catches only
// the few nearest; Pixiv's book mode lays them side by side, so every page lands
// inside the same vertical band and all of them pass. Guessing the shape from the
// DOM costs a render pass and guesses wrong, so the user declares it per site and
// `auto` stays the default for anything that is not a reader at all.

export type ReaderMode = "auto" | "vertical-scroll" | "paged" | "horizontal-slide";

export const READER_MODES: readonly ReaderMode[] = [
  "auto",
  "vertical-scroll",
  "paged",
  "horizontal-slide",
];

/**
 * Real readers per mode, shown in the Options page so the list doubles as
 * documentation. Membership carries no behaviour: only the user's per-host
 * choice does, so a site appearing here is never treated as a reader.
 */
export const MODE_EXAMPLES: Record<ReaderMode, readonly string[]> = {
  auto: ["mọi trang khác (chat, mạng xã hội, diễn đàn)"],
  "vertical-scroll": ["mangadex.org (chế độ Long Strip)", "mangareader.to", "truyenqqko.com"],
  paged: ["mangadex.org (mặc định)", "cuutruyen.net", "moetruyen.com", "truyenqqko.com"],
  "horizontal-slide": ["comic.pixiv.net", "manga.bilibili.com"],
};

/** Hostname without a leading "www.", so people can type sites how they write them. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

/**
 * Subtrees a site's own chrome lives in, keyed by host, never matched globally.
 *
 * comix.to's comment section lives under classes like `.cm-widget` and
 * `.cm-item`, which contain no generic "comment" token, so only the host can
 * identify them. Membership is per-host by construction: a host with no entry
 * gets an empty list, which is what keeps every other site byte-for-byte
 * unchanged.
 */
export const IGNORED_SUBTREES: Record<string, readonly string[]> = {
  "comix.to": [".cm-widget", ".rpage-strip-comments"],
};
export function ignoredSubtrees(host: string): readonly string[] {
  return IGNORED_SUBTREES[normalizeHost(host)] ?? [];
}

/**
 * Coerce an untrusted stored value to a known mode.
 *
 * Anything unrecognised becomes `auto`: a stale or hand-edited entry must never
 * be able to widen discovery on a site the user never configured.
 */
export function normalizeMode(value: unknown): ReaderMode {
  return typeof value === "string" && (READER_MODES as readonly string[]).includes(value)
    ? (value as ReaderMode)
    : "auto";
}

/**
 * Whether Alt+T should enqueue every candidate in the document rather than only
 * the ones near the viewport.
 *
 * True for every declared reader layout: naming a site a reader is the user
 * saying "Alt+T means translate this chapter". `paged` wins nothing here — pages
 * that have not been clicked yet are simply absent from the DOM — but the store
 * in store.ts is what makes a paged reader keep what it has already translated.
 */
export function enqueuesWholeDocument(mode: ReaderMode): boolean {
  return mode !== "auto";
}

/** Narrow an untrusted per-host record to `{ host: ReaderMode }` with valid modes. */
export function narrowReaderModes(raw: unknown): Record<string, ReaderMode> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, ReaderMode> = {};
  for (const [host, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = normalizeHost(host);
    // An empty host could never match location.hostname, so storing one would
    // only be a silent no-op the user cannot see or undo.
    if (!key) continue;
    const mode = normalizeMode(value);
    // `auto` is the default for every unconfigured host; recording it would grow
    // the record without changing any behaviour.
    if (mode === "auto") continue;
    out[key] = mode;
  }
  return out;
}