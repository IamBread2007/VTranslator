import { createServer, type Server } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium, type BrowserContext } from "playwright";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_DIR = join(HERE, "fixtures");
const DIST = join(HERE, "..", "..", "dist");

/**
 * Fixtures need bitmaps with real intrinsic dimensions.
 *
 * Discovery reads `naturalWidth`/`naturalHeight` first and only falls back to the
 * width/height attributes, so a 1x1 placeholder makes every page look like an
 * icon and the minimum-edge rule rejects all of them. Fixtures that stub geometry
 * would pass unit tests and fail here for the wrong reason.
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Solid-colour truecolour PNG of the requested size, unfiltered scanlines. */
export function solidPng(width: number, height: number, rgb: [number, number, number] = [232, 232, 238]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter type "none"
    for (let x = 0; x < width; x++) {
      raw[o++] = rgb[0];
      raw[o++] = rgb[1];
      raw[o++] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const PAGE_PNG = solidPng(800, 1200);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
};

export interface Harness {
  context: BrowserContext;
  extensionId: string;
  origin: string;
  close(): Promise<void>;
}

async function serveFixtures(): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);

    // Synthesised so fixture pages need no binary files in the repository.
    // Dimensions may be requested as /page/<w>x<h>.png; the bare /page/<n>.png
    // form serves the default page shape.
    const sized = /^\/page\/(\d+)x(\d+)\.png$/.exec(path);
    if (sized) {
      const png = solidPng(Number(sized[1]), Number(sized[2]));
      res.writeHead(200, { "content-type": "image/png", "content-length": png.length });
      res.end(png);
      return;
    }
    if (/^\/page\/\d+\.png$/.test(path)) {
      res.writeHead(200, { "content-type": "image/png", "content-length": PAGE_PNG.length });
      res.end(PAGE_PNG);
      return;
    }
    if (path === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }

    const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    // Contain the join before it reaches the filesystem: without the separator
    // in the prefix, "fixtures-evil" would pass a bare startsWith check.
    const target = join(FIXTURE_DIR, rel);
    if (target !== FIXTURE_DIR && !target.startsWith(FIXTURE_DIR + sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = await readFile(target);
      const ext = target.slice(target.lastIndexOf("."));
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("fixture server did not bind a TCP port");
  }
  return { server, origin: `http://127.0.0.1:${addr.port}` };
}

/**
 * Launches a headed Chromium with the built extension loaded.
 *
 * Headed is the default and is not a preference: Chrome refuses to load an
 * unpacked extension in headless mode, so a headless run would fail at exactly
 * the step this harness exists to perform. The failure message says so rather
 * than degrading quietly.
 */
export async function launch(opts: { headless?: boolean } = {}): Promise<Harness> {
  const { server, origin } = await serveFixtures();
  const userDataDir = await mkdtemp(join(tmpdir(), "mt-harness-"));

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: opts.headless ?? false,
      args: [
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
  } catch (err) {
    server.close();
    await rm(userDataDir, { recursive: true, force: true });
    throw new Error(
      `Could not launch a headed Chromium with the extension at ${DIST}. ` +
        `Headless is not retried, because headless cannot load an unpacked ` +
        `extension. Underlying error: ${String(err)}`,
    );
  }

  // Chrome derives an unpacked extension's id from its absolute path, so the
  // value changes per machine and per checkout location. Reading it off the
  // running MV3 service worker is the only stable source.
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;

  return {
    context,
    extensionId,
    origin,
    async close(): Promise<void> {
      await context.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}