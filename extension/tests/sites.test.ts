import { describe, expect, it } from "vitest";
import {
  READER_MODES,
  MODE_EXAMPLES,
  enqueuesWholeDocument,
  normalizeHost,
  normalizeMode,
  type ReaderMode,
} from "../src/sites";

describe("normalizeHost", () => {
  it("drops a leading www so people can type the site how they write it", () => {
    expect(normalizeHost("www.mangadex.org")).toBe("mangadex.org");
    expect(normalizeHost("mangadex.org")).toBe("mangadex.org");
  });

  it("is case-insensitive and trims stray whitespace", () => {
    expect(normalizeHost("  MangaDex.ORG ")).toBe("mangadex.org");
  });

  it("keeps a meaningful subdomain and only strips www", () => {
    expect(normalizeHost("comic.pixiv.net")).toBe("comic.pixiv.net");
    expect(normalizeHost("www.comic.pixiv.net")).toBe("comic.pixiv.net");
  });

  it("is empty for input with no host at all", () => {
    expect(normalizeHost("")).toBe("");
  });
});

describe("normalizeMode", () => {
  it("keeps every known mode", () => {
    for (const m of READER_MODES) expect(normalizeMode(m)).toBe(m);
  });

  it("falls back to auto for anything unrecognised", () => {
    // Stored values are untrusted: a stale or hand-edited entry must not make
    // the extension widen discovery on a site the user never configured.
    expect(normalizeMode("sideways")).toBe("auto");
    expect(normalizeMode(undefined)).toBe("auto");
    expect(normalizeMode(null)).toBe("auto");
    expect(normalizeMode(7)).toBe("auto");
  });
});

describe("enqueuesWholeDocument", () => {
  it("scopes auto to the viewport neighbourhood", () => {
    // Social feeds and forums are not readers: their pages infinite-scroll, and
    // Alt+T must not swallow every image ever posted in the channel.
    expect(enqueuesWholeDocument("auto")).toBe(false);
  });

  it("widens for every declared reader layout", () => {
    // Declaring a site a reader is the user saying "Alt+T means translate this
    // chapter", which is why all three reader modes share the wider scope.
    for (const m of READER_MODES.filter((x) => x !== "auto")) {
      expect(enqueuesWholeDocument(m)).toBe(true);
    }
  });
});

describe("MODE_EXAMPLES", () => {
  it("documents every mode with at least one real site", () => {
    for (const m of READER_MODES) expect(MODE_EXAMPLES[m].length).toBeGreaterThan(0);
  });

  it("places the sites the reader was described as behaving like", () => {
    const has = (m: ReaderMode, host: string) =>
      MODE_EXAMPLES[m].some((e) => e.includes(host));
    expect(has("paged", "mangadex.org")).toBe(true);
    expect(has("horizontal-slide", "comic.pixiv.net")).toBe(true);
  });
});