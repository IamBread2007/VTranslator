import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { solidPng } from "./harness";

export interface StubRequest {
  /** prev_context the extension sent, in order. */
  prevContext: string[];
  bodyBytes: number;
}

export interface StubServer {
  origin: string;
  token: string;
  requests: StubRequest[];
  /** Requests the client tore down before a response was written. */
  aborted: number[];
  /** Held requests, when started with `{ hold: true }`. */
  readonly held: number;
  /** Answers every held request. */
  release(): void;
  close(): Promise<void>;
}

export interface StubOptions {
  /**
   * Accept requests but never answer them, so a test can act while a page is
   * genuinely in flight. Needed to observe Stop rather than infer it.
   */
  hold?: boolean;
}

/**
 * A minimal stand-in for the local translate server.
 *
 * Lifecycle tests need pages to actually *succeed*: with no reachable server every
 * page lands in the error state, and an ordering assertion over failed pages says
 * nothing about whether the success path is correct. It also gives the tests a
 * place to observe prev_context, which is the only way to check that pages were
 * dispatched in reading order rather than merely completed.
 */
export async function startStubServer(opts: StubOptions = {}): Promise<StubServer> {
  const png = solidPng(800, 1200).toString("base64");
  const requests: StubRequest[] = [];
  const aborted: number[] = [];
  const heldResponses: ServerResponse[] = [];
  let held = 0;

  const body = (): string =>
    JSON.stringify({
      width: 800,
      height: 1200,
      inpainted_png: png,
      resolved_source_lang: "ja",
      blocks: [],
      warnings: [],
    });

  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    // The client vanished. Which event reports it depends on how far the request
    // got: `aborted` when the body was still uploading, and a response that
    // closes before it finished being written otherwise. Both mean the same
    // thing to Stop, so both are counted.
    req.on("aborted", () => aborted.push(requests.length));
    res.on("close", () => {
      if (!res.writableFinished) aborted.push(requests.length);
    });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let prevContext: string[] = [];
      // Multipart is parsed by a targeted match rather than a full parser: the
      // tests only need one known field, and a dependency-free regex keeps the
      // harness installable without the server's own requirements.
      const m = /name="options"\r?\n\r?\n(\{[\s\S]*?\})/.exec(raw);
      if (m) {
        try {
          prevContext = (JSON.parse(m[1]) as { prev_context?: string[] }).prev_context ?? [];
        } catch {
          prevContext = [];
        }
      }
      requests.push({ prevContext, bodyBytes: raw.length });

      if (opts.hold) {
        held += 1;
        heldResponses.push(res);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body());
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${addr.port}`,
    token: "stub-token",
    requests,
    aborted,
    get held() {
      return held;
    },
    release: () => {
      for (const res of heldResponses.splice(0)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body());
      }
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}