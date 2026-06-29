// Static export build for Cloudflare Pages (free, no backend).
//
// The browser webcam demo (smoking + litter ONNX inference) is fully
// client-side and needs no server. The app/api/* route handlers are
// server-only and are incompatible with `output: export`, so we move
// them aside for the duration of the build, then always restore them.
//
// Usage: npm run build:static  ->  outputs ./out
import { existsSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const apiDir = join(root, "app", "api");
const stashDir = join(root, "app", "_api_static_stash");

function restore() {
  if (existsSync(stashDir)) {
    renameSync(stashDir, apiDir);
    console.log("[build:static] restored app/api");
  }
}

// Make sure we put the routes back even on crash / Ctrl-C.
process.on("exit", restore);
process.on("SIGINT", () => { restore(); process.exit(1); });

let moved = false;
try {
  if (existsSync(apiDir)) {
    renameSync(apiDir, stashDir);
    moved = true;
    console.log("[build:static] temporarily moved app/api out of the build");
  }

  const result = spawnSync("npx", ["next", "build"], {
    stdio: "inherit",
    env: { ...process.env, STATIC_EXPORT: "1" },
    shell: true,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  console.log("[build:static] done -> ./out");
} finally {
  if (moved) restore();
}
