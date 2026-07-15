#!/usr/bin/env node
import { accessSync, constants, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startVSCodeSync } from "./scriptcat-vscode-sync.mjs";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
export const defaultScriptPath = "greenmangaming-bundle-claim.user.js";
export const defaultPort = 8642;
export const defaultTimeoutMs = 45_000;

export function usage() {
  return [
    "usage: pnpm install:scriptcat -- [options] [script.user.js]",
    "",
    "Push a repository userscript to the normal browser through ScriptCat VSCode sync.",
    "",
    "options:",
    `  --port=<port>             ScriptCat VSCode sync port, default ${defaultPort}`,
    `  --timeout-ms=<ms>         Browser connection timeout, default ${defaultTimeoutMs}`,
    "  --watch                   Keep syncing when the script file changes",
    "  --help                    Show this help",
    "",
    `default script: ${defaultScriptPath}`,
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    port: defaultPort,
    timeoutMs: defaultTimeoutMs,
    watch: false,
    scriptPath: defaultScriptPath,
  };
  let scriptSpecified = false;

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
      if (scriptSpecified) {
        throw new Error("only one userscript file may be specified");
      }
      options.scriptPath = arg;
      scriptSpecified = true;
    }
  }

  return options;
}

export function validateOptions(options) {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`invalid port: ${options.port}`);
  }

  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0) {
    throw new Error(`invalid timeout-ms: ${options.timeoutMs}`);
  }
}

function ensureReadableFile(path) {
  accessSync(path, constants.R_OK);
  if (!statSync(path).isFile()) {
    throw new Error(`userscript path is not a file: ${path}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  validateOptions(options);

  const scriptPath = resolve(repoRoot, options.scriptPath);
  ensureReadableFile(scriptPath);

  console.log(`[scriptcat-install] target script: ${basename(scriptPath)}`);
  console.log(`[scriptcat-install] waiting for ScriptCat at ws://127.0.0.1:${options.port}`);

  const sync = await startVSCodeSync({
    port: options.port,
    scriptPath,
    timeoutMs: options.timeoutMs,
    watch: options.watch,
    log: message => console.log(`[scriptcat-install] ${message}`),
  });
  const close = () => void sync.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await sync.completion;
  } finally {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[scriptcat-install] ${error.message}`);
    process.exitCode = 1;
  });
}
