#!/usr/bin/env node
import { accessSync, constants } from "node:fs";
import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const syncServerPath = resolve(repoRoot, "scripts/mcp/scriptcat-vscode-sync-server.mjs");
const defaultScriptPath = "greenmangaming-bundle-claim.user.js";
const defaultPort = 8642;
const defaultTimeoutMs = 45000;

function printUsage() {
  console.log(
    [
      "usage: node scripts/userscripts/install-to-scriptcat.mjs [options] [script.user.js]",
      "",
      "options:",
      "  --port=<port>             ScriptCat VSCode sync port, default 8642",
      "  --timeout-ms=<ms>         Wait time for browser connection, default 45000",
      "  --watch                   Keep syncing when the script file changes",
      "  --help                    Show this help",
      "",
      `default script: ${defaultScriptPath}`,
    ].join("\n")
  );
}

function parseArgs(argv) {
  const options = {
    port: defaultPort,
    timeoutMs: defaultTimeoutMs,
    watch: false,
    scriptPath: defaultScriptPath,
  };

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--watch") {
      options.watch = true;
    } else if (arg.startsWith("--port=")) {
      options.port = Number(arg.slice("--port=".length));
    } else if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      options.scriptPath = arg;
    }
  }

  return options;
}

function validateOptions(options) {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`invalid port: ${options.port}`);
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new Error(`invalid timeout-ms: ${options.timeoutMs}`);
  }
}

function ensureReadableFile(path) {
  accessSync(path, constants.R_OK);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  validateOptions(options);

  const scriptPath = resolve(repoRoot, options.scriptPath);
  ensureReadableFile(scriptPath);
  ensureReadableFile(syncServerPath);

  const syncArgs = [
    syncServerPath,
    `--port=${options.port}`,
    `--timeout-ms=${options.timeoutMs}`,
  ];

  if (options.watch) {
    syncArgs.push("--watch");
  } else {
    syncArgs.push("--once");
  }

  syncArgs.push(scriptPath);

  console.log(`[scriptcat-install] target script: ${basename(scriptPath)}`);
  console.log(`[scriptcat-install] waiting for ScriptCat at ws://127.0.0.1:${options.port}`);

  const child = spawn(process.execPath, syncArgs, {
    cwd: repoRoot,
    stdio: "inherit",
  });

  await new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("exit", code => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`ScriptCat install failed with exit code ${code}`));
    });
  });
}

main().catch(error => {
  console.error(`[scriptcat-install] ${error.message}`);
  process.exit(1);
});
