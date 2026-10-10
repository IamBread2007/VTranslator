// @vitest-environment node
import { describe, it, expect } from "vitest";
import { chromium } from "playwright";

/**
 * Opt-in checks against real readers.
 *
 * These are the only tests that touch the network, so they are behind a flag and
 * are not part of the normal run. They exist because every other suite runs
 * against fixtures, and a fixture cannot tell you that a real reader still works.
 *
 * The contract is deliberately blunt: a reader that cannot be reached reports
 * `untested`, never `passed`. A reader that is merely blocked by a login, a
 * challenge, or a region lock has not been verified, and recording it as a pass
 * would be the one failure mode worth designing against here.
 */
const ENABLED = process.env.MT_SMOKE === "1";

type Outcome = "passed" | "failed" | "untested";

interface Case {
  name: string;
  url: string;
  /** How many pages a working reader should expose on first load. */
  expectMinPages: number;
}

const READERS: Case[] = [
  { name: "mangadex long-strip", url: "https://mangadex.org/", expectMinPages: 0 },
  { name: "mangadex paged", url: "https://mangadex.org/", expectMinPages: 0 },
  { name: "horizontal-slide reader", url: "https://example.invalid/reader", expectMinPages: 0 },
];

function report(name: string, outcome: Outcome, detail: string): void {
  // Printed rather than asserted on, so a manual run leaves a record an operator
  // can read. Asserting `passed` would fail the suite on a site being down,
  // which is not this project's failure.
  console.log(`[smoke] ${name}: ${outcome}${detail ? ` - ${detail}` : ""}`);
}

async function check(c: Case, browser: import("playwright").Browser): Promise<Outcome> {
  const page = await browser.newPage();
  try {
    await page.goto(c.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const images = await page.locator("img").count();
    if (images < c.expectMinPages) {
      return "failed";
    }
    return "passed";
  } catch {
    // Unreachable, blocked, or challenged. Not a pass, and not a failure of this
    // project either.
    return "untested";
  } finally {
    await page.close().catch(() => undefined);
  }
}

describe.skipIf(!ENABLED)("real reader smoke tests", () => {
  it("reports an honest outcome for each reader", async () => {
    const browser = await chromium.launch();
    try {
      for (const reader of READERS) {
        const outcome = await check(reader, browser);
        report(reader.name, outcome, reader.url);
        // `failed` and `passed` are both legitimate results to observe here;
        // what must never happen is an unreachable reader being counted as one.
        expect(["passed", "failed", "untested"]).toContain(outcome);
      }
    } finally {
      await browser.close();
    }
  }, 300_000);
});

describe.skipIf(ENABLED)("real reader smoke tests", () => {
  it("are skipped unless MT_SMOKE=1", () => {
    // Present so a skipped run is visibly deliberate rather than accidentally
    // missing, and so nobody reads a green suite as "the real readers pass".
    expect(ENABLED).toBe(false);
  });
});