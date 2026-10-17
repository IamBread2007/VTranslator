import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { Script } from "node:vm";
import { build } from "esbuild";

// Entries appear as their modules are implemented (Tasks 9→13).
const ENTRIES = ["src/options.ts", "src/background.ts", "src/content.ts"];

mkdirSync("dist", { recursive: true });

const inputs = ENTRIES.filter((e) => existsSync(e));
if (inputs.length === 0) throw new Error("no entry points to bundle");

const wasmGlue = "core/pkg/mt_layout.js";
const wasm = "core/pkg/mt_layout_bg.wasm";
if (!existsSync(wasmGlue)) {
  process.stderr.write("layout wasm glue missing; run npm run wasm:build\n");
  process.exit(1);
}
if (!existsSync(wasm)) {
  process.stderr.write("layout.wasm missing; run npm run wasm:build\n");
  process.exit(1);
}

await build({
  entryPoints: inputs,
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: true,
});

for (const f of ["manifest.json", "src/options.html"]) {
  cpSync(f, `dist/${f.replace("src/", "")}`);
}
if (existsSync("fonts")) cpSync("fonts", "dist/fonts", { recursive: true });

// Task 6 loads these bytes at runtime, so the wasm must sit next to the bundles.
cpSync(wasm, "dist/layout.wasm");

// Chrome injects content scripts as classic scripts, so parsing here catches
// syntax (such as import.meta) that Node's ESM package mode would accept.
new Script(readFileSync("dist/content.js", "utf8"), { filename: "dist/content.js" });

process.stdout.write(`built ${inputs.length} bundle(s) → dist/\n`);
