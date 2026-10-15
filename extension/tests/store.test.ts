import { describe, expect, it, vi } from "vitest";
import { TranslationStore } from "../src/store";

describe("TranslationStore", () => {
  it("returns the object URL a page was translated to", () => {
    const s = new TranslationStore();
    s.set("https://reader/p1.jpg", "blob:one");
    expect(s.get("https://reader/p1.jpg")).toBe("blob:one");
    expect(s.has("https://reader/p1.jpg")).toBe(true);
  });

  it("misses for a page it has never translated", () => {
    expect(new TranslationStore().get("https://reader/p9.jpg")).toBeUndefined();
  });

  it("survives the element being removed from the page", () => {
    // The whole point of keying by URL: a paged reader unmounts the <img> when
    // the reader advances, and the translation must still be there to re-apply.
    const s = new TranslationStore();
    s.set("https://reader/p1.jpg", "blob:one");
    // Nothing to simulate — no element is involved at all. Assert the absence of
    // any element-keyed API so a future refactor cannot reintroduce one.
    expect(Object.keys(s)).toEqual(["byUrl", "max", "revoke"]);
  });

  it("revokes the object URL when an entry is explicitly released", () => {
    const revoke = vi.fn();
    const s = new TranslationStore({ revoke });
    s.set("https://reader/p1.jpg", "blob:one");
    s.delete("https://reader/p1.jpg");
    expect(s.has("https://reader/p1.jpg")).toBe(false);
    expect(revoke).toHaveBeenCalledWith("blob:one");
  });

  it("releasing an unknown URL revokes nothing", () => {
    const revoke = vi.fn();
    new TranslationStore({ revoke }).delete("https://reader/nope.jpg");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("evicts the least recently used entry and revokes its blob", () => {
    const revoke = vi.fn();
    const s = new TranslationStore({ max: 2, revoke });
    s.set("a", "blob:a");
    s.set("b", "blob:b");
    s.set("c", "blob:c");
    expect(s.has("a")).toBe(false);
    expect(revoke).toHaveBeenCalledWith("blob:a");
    expect(s.size).toBe(2);
  });

  it("counts a read as a use, so a page you keep coming back to is not evicted", () => {
    const revoke = vi.fn();
    const s = new TranslationStore({ max: 2, revoke });
    s.set("a", "blob:a");
    s.set("b", "blob:b");
    s.get("a"); // re-read page a; page b is now the least recently used
    s.set("c", "blob:c");
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(false);
    expect(revoke).toHaveBeenCalledWith("blob:b");
  });

  it("re-translating a URL releases the previous blob instead of leaking it", () => {
    const revoke = vi.fn();
    const s = new TranslationStore({ revoke });
    s.set("https://reader/p1.jpg", "blob:old");
    s.set("https://reader/p1.jpg", "blob:new");
    expect(s.get("https://reader/p1.jpg")).toBe("blob:new");
    expect(revoke).toHaveBeenCalledWith("blob:old");
  });

  it("stays bounded under a long chapter", () => {
    const revoke = vi.fn();
    const s = new TranslationStore({ max: 3, revoke });
    for (let i = 0; i < 50; i++) s.set(`https://reader/p${i}.jpg`, `blob:${i}`);
    expect(s.size).toBe(3);
    expect(revoke).toHaveBeenCalledTimes(47);
  });

  it("clear releases every blob it held", () => {
    const revoke = vi.fn();
    const s = new TranslationStore({ revoke });
    s.set("a", "blob:a");
    s.set("b", "blob:b");
    s.clear();
    expect(s.size).toBe(0);
    expect(revoke).toHaveBeenCalledWith("blob:a");
    expect(revoke).toHaveBeenCalledWith("blob:b");
  });

  it("defaults to URL.revokeObjectURL so real blobs are not leaked", () => {
    const spy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const s = new TranslationStore();
    s.set("a", "blob:a");
    s.delete("a");
    expect(spy).toHaveBeenCalledWith("blob:a");
    spy.mockRestore();
  });
});

describe("page detail (edit history)", () => {
  function detail(tag: string) {
    return {
      inpaintedBlob: new Blob([`png:${tag}`]),
      blocks: [
        {
          id: 1,
          box: { x: 0, y: 0, w: 10, h: 10 },
          render_box: { x: 0, y: 0, w: 10, h: 10 },
          kind: "text_bubble" as const,
          source: tag,
          translation: tag,
          style: {
            color: "#000000",
            stroke_color: "#ffffff",
            stroke_width: 0,
            font_px: 12,
            font: "dialogue" as const,
          },
        },
      ],
    };
  }

  it("returns the stored bitmap and blocks with the entry", () => {
    const s = new TranslationStore();
    s.set("https://reader/p1.jpg", "blob:one", detail("p1"));
    const entry = s.getEntry("https://reader/p1.jpg");
    expect(entry?.objectUrl).toBe("blob:one");
    expect(entry?.blocks?.[0].translation).toBe("p1");
    expect(entry?.inpaintedBlob?.size).toBeGreaterThan(0);
  });

  it("evicts the inpainted bitmap past 20 pages but keeps the object URL", () => {
    const revoke = vi.fn();
    const s = new TranslationStore({ revoke });
    for (let i = 0; i < 21; i++) s.set(`page${i}`, `blob:${i}`, detail(`p${i}`));

    // The 21st entry is one past the detail cap: its history is gone, its page
    // is still re-appliable from the URL, and nothing was revoked for it.
    expect(s.getEntry("page0")?.objectUrl).toBe("blob:0");
    expect(s.getEntry("page0")?.inpaintedBlob).toBeUndefined();
    expect(s.getEntry("page0")?.blocks).toBeUndefined();
    expect(s.getEntry("page1")?.inpaintedBlob).toBeDefined();
    expect(s.size).toBe(21);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("a re-read keeps that page's detail, dropping the oldest instead", () => {
    const s = new TranslationStore();
    for (let i = 0; i < 20; i++) s.set(`page${i}`, `blob:${i}`, detail(`p${i}`));
    s.get("page0"); // page 0 is now the most recently used
    s.set("page20", "blob:20", detail("p20"));

    expect(s.getEntry("page0")?.inpaintedBlob).toBeDefined();
    expect(s.getEntry("page1")?.inpaintedBlob).toBeUndefined();
  });

  it("loses the detail with the entry once the URL cap evicts it", () => {
    const revoke = vi.fn();
    const s = new TranslationStore({ max: 2, revoke });
    s.set("a", "blob:a", detail("a"));
    s.set("b", "blob:b", detail("b"));
    s.set("c", "blob:c", detail("c"));
    expect(s.getEntry("a")).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith("blob:a");
    expect(s.getEntry("c")?.inpaintedBlob).toBeDefined();
  });

  it("finds the page an object URL belongs to", () => {
    const s = new TranslationStore({ max: 1 });
    s.set("https://reader/p1.jpg", "blob:one", detail("p1"));
    expect(s.find("blob:one")?.url).toBe("https://reader/p1.jpg");
    expect(s.find("blob:one")?.entry.blocks?.[0].translation).toBe("p1");
    s.set("https://reader/p2.jpg", "blob:two");
    expect(s.find("blob:one")).toBeUndefined();
  });
});