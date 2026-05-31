#!/usr/bin/env node
/**
 * Lint only userscripts produced by build-userscripts.mjs (src/userscripts → repo root).
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../..");
const sourceDir = path.join(repoRoot, "src", "userscripts");
const lintScript = path.join(__dirname, "lint.cjs");

function listBuiltTargets() {
  if (!fs.existsSync(sourceDir)) {
    console.error("[userscript-lint-built] missing directory:", sourceDir);
    process.exit(1);
  }
  return fs
    .readdirSync(sourceDir)
    .filter((name) => name.endsWith(".user.js"))
    .map((name) => path.join(repoRoot, name))
    .sort();
}

const targets = listBuiltTargets();
if (targets.length === 0) {
  console.log("[userscript-lint-built] no src/userscripts/*.user.js entries; nothing to lint");
  process.exit(0);
}

console.log(`[userscript-lint-built] linting ${targets.length} built artifact(s)`);
const result = spawnSync(process.execPath, [lintScript, "--", ...targets.map((p) => path.relative(repoRoot, p))], {
  cwd: repoRoot,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
