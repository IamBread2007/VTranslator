// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const buildScript = fileURLToPath(new URL("../build.mjs", import.meta.url));

function runBuildWithAssets(assets: string[]): { status: number | null; stderr: string; stdout: string } {
  const fixture = mkdtempSync(join(tmpdir(), "manga-translator-build-preflight-"));
  try {
    mkdirSync(join(fixture, "src"), { recursive: true });
    mkdirSync(join(fixture, "core", "pkg"), { recursive: true });
    writeFileSync(join(fixture, "src", "content.ts"), "export {};\n");
    for (const asset of assets) {
      writeFileSync(join(fixture, "core", "pkg", asset), "fixture");
    }
    const result = spawnSync(process.execPath, [buildScript], {
      cwd: fixture,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe("extension build preflight", () => {
  it("reports missing wasm glue before esbuild", () => {
    const result = runBuildWithAssets(["mt_layout_bg.wasm"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("layout wasm glue missing; run npm run wasm:build");
    expect(result.stdout).not.toContain("built ");
  });

  it("reports missing WASM before esbuild with the documented command", () => {
    const result = runBuildWithAssets(["mt_layout.js"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("layout.wasm missing; run npm run wasm:build");
    expect(result.stdout).not.toContain("built ");
  });
});
