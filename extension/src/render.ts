import { fitText, type Measure } from "./layout";
import type { Block, TranslateResponse } from "./types";

export const FONT_FILES: Record<Block["style"]["font"], string> = {
  dialogue: "PatrickHand-Regular.woff2",
  shout: "Bangers-Regular.woff2",
  narration: "BeVietnamPro-Regular.woff2",
};

// Narration renders at weight 700; without the real bold face the browser
// synthesises faux-bold, so register it under the same family.
const EXTRA_FACES: { family: string; file: string; weight: number }[] = [
  { family: "MT Be Vietnam Pro", file: "BeVietnamPro-Bold.woff2", weight: 700 },
];

const FONT_FAMILY: Record<Block["style"]["font"], string> = {
  dialogue: "MT Patrick Hand",
  shout: "MT Bangers",
  narration: "MT Be Vietnam Pro",
};

let fontsReady: Promise<void> | null = null;

function loadFonts(): Promise<void> {
  if (!fontsReady) {
    const entries = Object.entries(FONT_FAMILY) as [Block["style"]["font"], string][];
    fontsReady = Promise.all(
      entries.map(([role, family]) => {
        const url = chrome.runtime.getURL(`fonts/${FONT_FILES[role]}`);
        const face = new FontFace(family, `url(${url}) format("woff2")`);
        return face.load().then((loaded) => {
          document.fonts.add(loaded);
        });
      }),
    )
      .then(() =>
        Promise.all(
          EXTRA_FACES.map(({ family, file, weight }) => {
            const url = chrome.runtime.getURL(`fonts/${file}`);
            const face = new FontFace(family, `url(${url}) format("woff2")`, {
              weight: String(weight),
            });
            return face.load().then((loaded) => {
              document.fonts.add(loaded);
            });
          }),
        ),
      )
      .then(() => undefined);
  }
  return fontsReady;
}

/** Canvas measures text with the same font CSS will use. */
function makeMeasure(family: string, weight: number): Measure {
  const ctx = document.createElement("canvas").getContext("2d")!;
  return (text: string, px: number) => {
    ctx.font = `${weight} ${px}px "${family}"`;
    return ctx.measureText(text).width;
  };
}

/**
 * font_px from the server is a hint for the source page, not an upper bound:
 * manga is often taller than wide, so geometric space allows bigger text.
 */
export function fontBounds(block: Block): { minPx: number; maxPx: number } {
  const { h } = block.render_box;
  const geometricMax = Math.max(16, Math.floor(h * 0.8));
  const hintedMax = Math.max(16, Math.floor(block.style.font_px * 1.6));
  const maxPx = Math.min(180, Math.max(geometricMax, hintedMax));
  const minPx = Math.max(10, Math.min(18, Math.floor(h * 0.08)));
  return { minPx, maxPx };
}

export async function composePage(resp: TranslateResponse): Promise<Blob> {
  await loadFonts();
  const bytes = Uint8Array.from(atob(resp.inpainted_png), (c) => c.charCodeAt(0));
  const img = new Blob([bytes], { type: "image/png" });
  const bmp = await createImageBitmap(img);

  const canvas = new OffscreenCanvas(resp.width, resp.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, resp.width, resp.height);
  bmp.close();

  for (const block of resp.blocks) {
    const { font, color, stroke_color, stroke_width } = block.style;
    const family = FONT_FAMILY[font];
    const weight = font === "narration" ? 700 : 400;
    const measure = makeMeasure(family, weight);
    const { minPx, maxPx } = fontBounds(block);
    const fit = fitText(block.translation, block.render_box, measure, {
      minPx,
      maxPx,
      lineHeight: 1.2,
    });
    if (fit.overflow) {
      console.warn(`MT: block ${block.id} text overflow at ${minPx}px`);
    }

    const r = block.render_box;
    ctx.font = `${weight} ${fit.fontPx}px "${family}"`;
    const lineH = fit.fontPx * 1.2;
    const totalH = fit.lines.length * lineH;
    let y = r.y + (r.h - totalH) / 2 + fit.fontPx;
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
