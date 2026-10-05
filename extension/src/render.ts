import { fitText, type Measure } from "./layout";
import type { Block, TranslateResponse } from "./types";

export const FONT_FILES: Record<Block["style"]["font"], string> = {
  dialogue: "PatrickHand-Regular.woff2",
  shout: "Bangers-Regular.woff2",
  narration: "BeVietnamPro-Regular.woff2",
};

// Narration draws at weight 700; without the real bold face the browser
// synthesises faux-bold, so ship it alongside the regular weight.
const BOLD_FILE = "BeVietnamPro-Bold.woff2";

export const FAMILY: Record<Block["style"]["font"], string> = {
  dialogue: "MT Patrick Hand",
  shout: "MT Bangers",
  narration: "MT Be Vietnam Pro",
};

/**
 * Service workers have no DOM, so faces are registered as FontFace objects
 * from fetched bytes rather than parsed from CSS.
 */
export async function ensureFonts(): Promise<void> {
  const entries = Object.entries(FAMILY) as [Block["style"]["font"], string][];
  await Promise.all([
    ...entries.map(([role, family]) =>
      registerFace(family, 400, chrome.runtime.getURL(`fonts/${FONT_FILES[role]}`)),
    ),
    registerFace(FAMILY.narration, 700, chrome.runtime.getURL(`fonts/${BOLD_FILE}`)),
  ]);
}

async function registerFace(family: string, weight: number, url: string): Promise<void> {
  const buf = await (await fetch(url)).arrayBuffer();
  const face = new FontFace(family, buf, { weight: String(weight) });
  await face.load();
  // SAFETY: the FontFaceSet lives on document in pages (content script) and on
  // the global in service workers; lib.dom types it only on Document.
  const g = globalThis as unknown as {
    document?: { fonts: FontFaceSet };
    fonts?: FontFaceSet;
  };
  const fonts = g.document?.fonts ?? g.fonts;
  if (!fonts) throw new Error("FontFaceSet unavailable in this realm");
  fonts.add(face);
}

/** Canvas measures with the exact face the renderer will draw. */
function makeMeasure(family: string, weight: number): Measure {
  const ctx = new OffscreenCanvas(1, 1).getContext("2d")!;
  return (text: string, px: number) => {
    ctx.font = `${weight} ${px}px "${family}"`;
    return ctx.measureText(text).width;
  };
}

/**
 * Server font_px describes the source bubble, not the target: a 72px clamp
 * would force Vietnamese (often longer) into unreadably small text on tall
 * pages. Geometry and the hint are both lower bounds; 180px is the hard cap.
 */
export function fontBounds(block: Block): { minPx: number; maxPx: number } {
  const { h } = block.render_box;
  const geometricMax = Math.max(16, Math.floor(h * 0.8));
  const hintedMax = Math.max(16, Math.floor(block.style.font_px * 1.6));
  const maxPx = Math.min(180, Math.max(geometricMax, hintedMax));
  const minPx = Math.max(10, Math.min(18, Math.floor(h * 0.08)));
  return { minPx, maxPx };
}

export interface ComposeOptions {
  /** Called once per block that cannot fit at minPx. */
  onOverflow?: (blockId: number, minPx: number) => void;
}

export async function composePage(
  resp: TranslateResponse,
  opts: ComposeOptions = {},
): Promise<Blob> {
  await ensureFonts();
  const bytes = Uint8Array.from(atob(resp.inpainted_png), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));

  const canvas = new OffscreenCanvas(resp.width, resp.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, resp.width, resp.height);
  bmp.close();

  for (const block of resp.blocks) {
    const { font, color, stroke_color, stroke_width } = block.style;
    const family = FAMILY[font];
    const weight = font === "narration" ? 700 : 400;
    const { minPx, maxPx } = fontBounds(block);
    const fit = fitText(block.translation, block.render_box, makeMeasure(family, weight), {
      minPx,
      maxPx,
      lineHeight: 1.2,
    });
    if (fit.overflow) opts.onOverflow?.(block.id, minPx);

    const r = block.render_box;
    ctx.font = `${weight} ${fit.fontPx}px "${family}"`;
    const lineH = fit.fontPx * fit.lineHeight;
    let y = r.y + (r.h - fit.lines.length * lineH) / 2 + fit.fontPx;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    for (const line of fit.lines) {
      const x = r.x + r.w / 2;
      if (stroke_width > 0 && stroke_color !== color) {
        ctx.lineWidth = stroke_width * 2;
        ctx.strokeStyle = stroke_color;
        ctx.strokeText(line, x, y);
      }
      ctx.fillStyle = color;
      ctx.fillText(line, x, y);
      y += lineH;
    }
  }
  return canvas.convertToBlob({ type: "image/png" });
}
