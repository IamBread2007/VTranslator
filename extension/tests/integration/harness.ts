import { createServer, type Server } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext } from "playwright";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_DIR = join(HERE, "fixtures");
const DIST = join(HERE, "..", "..", "dist");

// A decodable 1x1 PNG. The harness only proves the page and extension plumbing;
// fixtures that need real page geometry arrive with the fixture suite.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==",
  "base64",
);

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
    if (/^\/page\/\d+\.png$/.test(path)) {
      res.writeHead(200, { "content-type": "image/png", "content-length": PNG_1X1.length });
      res.end(PNG_1X1);
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