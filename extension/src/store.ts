// Translated images, keyed by the URL the page was served from.
//
// Keying by DOM element does not survive a paged reader: MangaDex unmounts the
// <img> (or reassigns its src) when the reader advances, so an element-keyed map
// is destroyed exactly when the user is most likely to come back to a page. The
// reader identifies a page by URL, and that URL outlives the node, so the store
// does too — coming back to page 3 re-applies the existing blob instantly instead
// of paying for the translation again.

import type { Block } from "./types";

/**
 * The heavy half of a finished page: everything an in-place edit needs to
 * re-render locally.
 *
 * Retained for the most recent pages only. An object URL already pins one
 * full-page PNG per entry; the inpainted bitmap is a second one, so it is
 * capped far below the URL cap and dropped for older pages, which a paged
 * reader still re-applies from the URL alone.
 */
export interface PageDetail {
  /** Full-page PNG with the text erased, the canvas base of a local re-render. */
  inpaintedBlob?: Blob;
  /** Blocks of the finished response, so an edit re-lays-out without a request. */
  blocks?: Block[];
}

export interface StoreEntry extends PageDetail {
  objectUrl: string;
}

/** A lookup for callers holding only an element's blob attribute. */
export interface StoreHit {
  url: string;
  entry: StoreEntry;
}

/**
 * Pages whose heavy detail is retained. The plan's per-tab bound is 20 pages of
 * edit history against the 200 entries the URL map holds.
 */
const DETAIL_MAX = 20;

export interface StoreOptions {
  /**
   * Entries retained before the least recently used one is evicted. A chapter is
   * tens of pages and an object URL pins a full-page PNG in memory, so this is
   * the bound on how much translated art one tab can hold.
   */
  max?: number;
  /** Overridable so tests need no real object URLs. */
  revoke?: (objectUrl: string) => void;
}

export class TranslationStore {
  /** url -> entry. Map iteration order is the LRU order: oldest first. */
  private readonly byUrl = new Map<string, StoreEntry>();
  private readonly max: number;
  private readonly revoke: (objectUrl: string) => void;

  constructor(opts: StoreOptions = {}) {
    this.max = opts.max ?? 200;
    this.revoke = opts.revoke ?? ((u) => URL.revokeObjectURL(u));
  }

  get size(): number {
    return this.byUrl.size;
  }

  has(url: string): boolean {
    return this.byUrl.has(url);
  }

  /** The object URL for `url`, and a mark that this page is in active use. */
  get(url: string): string | undefined {
    return this.getEntry(url)?.objectUrl;
  }

  /** The full entry for `url`, and a mark that this page is in active use. */
  getEntry(url: string): StoreEntry | undefined {
    const hit = this.byUrl.get(url);
    if (hit === undefined) return undefined;
    // Re-insert to move the entry to the end of the iteration order, so a reader
    // the user keeps paging back to is the last one evicted.
    this.byUrl.delete(url);
    this.byUrl.set(url, hit);
    return hit;
  }

  /** The page an object URL belongs to, for callers that only have the attribute. */
  find(objectUrl: string): StoreHit | undefined {
    for (const [url, entry] of this.byUrl) {
      if (entry.objectUrl === objectUrl) return { url, entry };
    }
    return undefined;
  }

  set(url: string, objectUrl: string, detail: PageDetail = {}): void {
    // Replacing a page drops the blob it superseded; keeping it would pin a
    // full-page PNG that nothing can reach again.
    this.delete(url);
    this.byUrl.set(url, { objectUrl, ...detail });
    while (this.byUrl.size > this.max) {
      const oldest = this.byUrl.keys().next();
      if (oldest.done) return;
      this.revoke((this.byUrl.get(oldest.value) as StoreEntry).objectUrl);
      this.byUrl.delete(oldest.value);
    }
    this.trimDetails();
  }

  delete(url: string): void {
    const existing = this.byUrl.get(url);
    if (existing === undefined) return;
    this.byUrl.delete(url);
    this.revoke(existing.objectUrl);
  }

  clear(): void {
    for (const entry of this.byUrl.values()) this.revoke(entry.objectUrl);
    this.byUrl.clear();
  }

  /**
   * Drop the heavy half of every entry past the detail cap. The most recent
   * detailed entries keep it, so the page the user is reading — and any page
   * they paged back to, which `get` moved to the end — stays editable.
   */
  private trimDetails(): void {
    let kept = 0;
    for (const url of [...this.byUrl.keys()].reverse()) {
      const entry = this.byUrl.get(url);
      if (!entry || (entry.inpaintedBlob === undefined && entry.blocks === undefined)) continue;
      if (kept < DETAIL_MAX) {
        kept++;
        continue;
      }
      delete entry.inpaintedBlob;
      delete entry.blocks;
    }
  }
}