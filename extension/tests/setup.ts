import { readFileSync } from "node:fs";
import { join } from "node:path";

import { initSync } from "../core/pkg/mt_layout.js";

// Tests have no `chrome`, so the wasm-loaded state is established here with the
// bytes straight off disk. Production instantiates the same module from the
// packaged URL in src/layout.ts; a test that cannot load must fail loudly.
//
// The path is resolved from import.meta.dirname, not import.meta.url: jsdom
// suites run with a virtual http origin, so a URL built from import.meta.url
// stops being a file: URL and readFileSync refuses it.
initSync({
  module: readFileSync(join(import.meta.dirname, "..", "core", "pkg", "mt_layout_bg.wasm")),
});