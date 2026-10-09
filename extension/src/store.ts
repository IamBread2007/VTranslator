// Translated images, keyed by the URL the page was served from.
//
// Keying by DOM element does not survive a paged reader: MangaDex unmounts the
// <img> (or reassigns its src) when the reader advances, so an element-keyed map
// is destroyed exactly when the user is most likely to come back to a page. The
// reader identifies a page by URL, and that URL outlives the node, so the store
// does too — coming back to page 3 re-applies the existing blob instantly instead
// of paying for the translation again.

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
  /** url -> object URL. Map iteration order is the LRU order: oldest first. */
  private readonly byUrl = new Map<string, string>();
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
    const hit = this.byUrl.get(url);
    if (hit === undefined) return undefined;
    // Re-insert to move the entry to the end of the iteration order, so a reader
    // the user keeps paging back to is the last one evicted.
    this.byUrl.delete(url);
    this.byUrl.set(url, hit);
    return hit;
  }

  set(url: string, objectUrl: string): void {
    // Replacing a page drops the blob it superseded; keeping it would pin a
    // full-page PNG that nothing can reach again.
    this.delete(url);
    this.byUrl.set(url, objectUrl);
    while (this.byUrl.size > this.max) {
      const oldest = this.byUrl.keys().next();
      if (oldest.done) return;
      this.revoke(this.byUrl.get(oldest.value) as string);
      this.byUrl.delete(oldest.value);
    }
  }

  delete(url: string): void {
    const existing = this.byUrl.get(url);
    if (existing === undefined) return;
    this.byUrl.delete(url);
    this.revoke(existing);
  }

  clear(): void {
    for (const objectUrl of this.byUrl.values()) this.revoke(objectUrl);
    this.byUrl.clear();
  }
}