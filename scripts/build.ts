// Bundles each hook and the CLI into dist/*.mjs for node. Unminified and without sourcemaps,
// so dist/ is readable and CI can diff it against a fresh build.
// Usage: bun scripts/build.ts [outdir]   (default dist/; the hook tests build into a temp dir)

import { rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const defaultOutdir = join(root, "dist");
const outdir = resolve(process.argv[2] ?? defaultOutdir);

const ENTRYPOINTS = [
  "src/hooks/session-start.ts",
  "src/hooks/prompt-submit.ts",
  "src/hooks/agent-gate.ts",
  "src/cli.ts",
];

// Only the default dist/ is wiped (stale bundles must not linger); a given outdir is trusted
// to be fresh, so a typo can never delete an unrelated directory.
if (outdir === defaultOutdir) rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ENTRYPOINTS.map((e) => join(root, e)),
  root: join(root, "src"),
  outdir,
  target: "node",
  format: "esm",
  naming: "[name].mjs",
  minify: false,
  sourcemap: "none",
  splitting: false,
});

if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}
for (const o of result.outputs) console.log(`${relative(root, o.path)}  ${o.size} B`);
