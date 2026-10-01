import { cpSync, existsSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

// Entries appear as their modules are implemented (Tasks 9→13).
const ENTRIES = ["src/options.ts", "src/background.ts", "src/content.ts"];

mkdirSync("dist", { recursive: true });

const inputs = ENTRIES.filter((e) => existsSync(e));
if (inputs.length === 0) throw new Error("no entry points to bundle");

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
process.stdout.write(`built ${inputs.length} bundle(s) → dist/\n`);
