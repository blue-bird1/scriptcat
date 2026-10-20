#!/usr/bin/env node
/**
 * Build readable userscripts from src/userscripts.
 *
 * This intentionally uses esbuild only for dependency graph resolution and
 * concatenation. Userscript output must stay readable:
 * - no minify
 * - no name mangling
 * - no sourcemap footer
 * - UserScript metadata stays as the first bytes of the output file
 */
import * as esbuild from "esbuild";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join, relative } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "node:util";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceDir = join(repoRoot, "src", "userscripts");

function log(message) {
  console.log(`[userscript-build] ${message}`);
}

function fail(message) {
  console.error(`[userscript-build] error: ${message}`);
  process.exit(1);
}

function parseOptions() {
  try {
    return parseArgs({
      options: {
        entry: { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
    }).values;
  } catch (error) {
    fail(error.message);
  }
}

function collectEntries() {
  if (!existsSync(sourceDir)) {
    fail(`missing source directory: ${relative(repoRoot, sourceDir)}`);
  }
  return readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".user.js"))
    .map((entry) => join(sourceDir, entry.name))
    .sort();
}

function splitUserscriptMetadata(source, entryPath) {
  const match = source.match(/^\/\/ ==UserScript==\n[\s\S]*?\n\/\/ ==\/UserScript==\n?/);
  if (!match) {
    fail(`${relative(repoRoot, entryPath)} must start with a UserScript metadata block`);
  }
  const metadata = match[0].trimEnd();
  const body = source.slice(match[0].length).replace(/^\s+/, "");
  return { metadata, body };
}

function extractLintPreamble(body) {
  const lines = body.split("\n");
  const kept = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (line === "") {
      index += 1;
      continue;
    }
    if (/^\/\*\s*(global|eslint-env|eslint|jshint)\b/.test(line)) {
      kept.push(lines[index]);
      index += 1;
      continue;
    }
    break;
  }
  return kept.join("\n");
}

function normalizeBuiltBody(body) {
  return body
    .replace(/^\s+/, "")
    .replace(/\s+$/, "");
}

async function buildEntry(entryPath) {
  const entryName = basename(entryPath);
  const outputPath = join(repoRoot, entryName);
  const source = readFileSync(entryPath, "utf8");
  const { metadata, body } = splitUserscriptMetadata(source, entryPath);
  const lintPreamble = extractLintPreamble(body);

  const result = await esbuild.build({
    stdin: {
      contents: body,
      sourcefile: entryPath,
      resolveDir: dirname(entryPath),
      loader: "js",
    },
    outfile: outputPath,
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "esnext",
    charset: "utf8",
    minify: false,
    sourcemap: false,
    legalComments: "inline",
    logLevel: "info",
    allowOverwrite: true,
  });

  const builtBody = normalizeBuiltBody(result.outputFiles[0].text);
  const preamble = lintPreamble ? `${lintPreamble}\n\n` : "";
  writeFileSync(outputPath, `${metadata}\n\n${preamble}${builtBody}\n`, "utf8");
  log(`${relative(repoRoot, entryPath)} -> ${entryName}`);
}

const options = parseOptions();
if (options.help) {
  console.error(`Usage: pnpm build [--entry <name.user.js>]... [--help]

Build readable userscripts from src/userscripts into the repository root.
Without --entry, build all collected entries.

Options:
  --entry <name.user.js>  Build a collected entry; repeat to select more entries.
  -h, --help             Show this help and exit.`);
  process.exit(0);
}

const entries = collectEntries();
const requestedEntries = new Set(options.entry);
const entryNames = new Set(entries.map((entry) => basename(entry)));
for (const name of requestedEntries) {
  if (!entryNames.has(name)) {
    fail(`unknown entry: ${name}; expected a filename collected from src/userscripts`);
  }
}
const selectedEntries = requestedEntries.size > 0
  ? entries.filter((entry) => requestedEntries.has(basename(entry)))
  : entries;
if (selectedEntries.length === 0) {
  log(`no *.user.js entries found in ${relative(repoRoot, sourceDir)}; nothing to build`);
  process.exit(0);
}

for (const entry of selectedEntries) {
  await buildEntry(entry);
}
