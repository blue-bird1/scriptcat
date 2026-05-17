#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const repoRoot = path.resolve(__dirname, "../..");
const compatGrantPath = path.join(__dirname, "scriptcat-eslint/compat-grant.cjs");
const compatHeadersPath = path.join(__dirname, "scriptcat-eslint/compat-headers.cjs");

const originalLoad = Module._load;
Module._load = function loadWithScriptCatCompat(request, parent, isMain) {
  if (request === "../data/compat-grant") {
    return originalLoad.call(this, compatGrantPath, parent, isMain);
  }
  if (request === "../data/compat-headers") {
    return originalLoad.call(this, compatHeadersPath, parent, isMain);
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { Linter } = require("eslint-linter-browserify");
const { configs, rules } = require("eslint-plugin-userscripts");

const defaultConfig = {
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "script",
    ecmaFeatures: {
      globalReturn: true,
    },
  },
  globals: {
    CATRetryError: "readonly",
    CAT_fileStorage: "readonly",
    CAT_userConfig: "readonly",
    CAT_registerMenuInput: "readonly",
    CAT_unregisterMenuInput: "readonly",
    CAT_scriptLoaded: "readonly",
  },
  rules: {
    "constructor-super": ["error"],
    "for-direction": ["error"],
    "getter-return": ["error"],
    "no-async-promise-executor": ["error"],
    "no-case-declarations": ["error"],
    "no-class-assign": ["error"],
    "no-compare-neg-zero": ["error"],
    "no-cond-assign": ["error"],
    "no-const-assign": ["error"],
    "no-constant-condition": ["error"],
    "no-control-regex": ["error"],
    "no-debugger": ["error"],
    "no-delete-var": ["error"],
    "no-dupe-args": ["error"],
    "no-dupe-class-members": ["error"],
    "no-dupe-else-if": ["error"],
    "no-dupe-keys": ["error"],
    "no-duplicate-case": ["error"],
    "no-empty": ["error"],
    "no-empty-character-class": ["error"],
    "no-empty-pattern": ["error"],
    "no-ex-assign": ["error"],
    "no-extra-boolean-cast": ["error"],
    "no-extra-semi": ["error"],
    "no-fallthrough": ["error"],
    "no-func-assign": ["error"],
    "no-global-assign": ["error"],
    "no-import-assign": ["error"],
    "no-inner-declarations": ["error"],
    "no-invalid-regexp": ["error"],
    "no-irregular-whitespace": ["error"],
    "no-loss-of-precision": ["error"],
    "no-misleading-character-class": ["error"],
    "no-mixed-spaces-and-tabs": ["error"],
    "no-new-symbol": ["error"],
    "no-nonoctal-decimal-escape": ["error"],
    "no-obj-calls": ["error"],
    "no-octal": ["error"],
    "no-prototype-builtins": ["error"],
    "no-redeclare": ["error"],
    "no-regex-spaces": ["error"],
    "no-self-assign": ["error"],
    "no-setter-return": ["error"],
    "no-shadow-restricted-names": ["error"],
    "no-sparse-arrays": ["error"],
    "no-this-before-super": ["error"],
    "no-undef": ["warn"],
    "no-unexpected-multiline": ["error"],
    "no-unreachable": ["error"],
    "no-unsafe-finally": ["error"],
    "no-unsafe-negation": ["error"],
    "no-unsafe-optional-chaining": ["error"],
    "no-unused-labels": ["error"],
    "no-unused-vars": ["warn"],
    "no-useless-backreference": ["error"],
    "no-useless-catch": ["error"],
    "no-useless-escape": ["error"],
    "no-with": ["error"],
    "require-yield": ["error"],
    "use-isnan": ["error"],
    "valid-typeof": ["error"],
    ...configs.recommended.rules,
  },
  env: {
    es6: true,
    browser: true,
    greasemonkey: true,
  },
};

defaultConfig.rules["userscripts/align-attributes"] = ["warn", 2];
defaultConfig.rules["userscripts/require-download-url"] = ["warn"];

function listDefaultTargets() {
  return fs
    .readdirSync(repoRoot)
    .filter((name) => name.endsWith(".user.js"))
    .map((name) => path.join(repoRoot, name));
}

function toTargetPath(arg) {
  return path.resolve(repoRoot, arg);
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const targets = args.length ? args.map(toTargetPath) : listDefaultTargets();
if (targets.length === 0) {
  console.log("[userscript-lint] no *.user.js files found");
  process.exit(0);
}

const linter = new Linter({ configType: "eslintrc" });
const userscriptRules = Object.fromEntries(
  Object.entries(rules).map(([key, rule]) => [`userscripts/${key}`, rule])
);
linter.defineRules(userscriptRules);

let warningCount = 0;
let errorCount = 0;

for (const target of targets) {
  const relativeTarget = path.relative(repoRoot, target);
  if (!fs.existsSync(target)) {
    console.error(`[userscript-lint] missing file: ${relativeTarget}`);
    errorCount += 1;
    continue;
  }

  const code = fs.readFileSync(target, "utf8");
  const messages = linter.verify(code, defaultConfig, { filename: relativeTarget });
  if (messages.length === 0) {
    console.log(`[userscript-lint] ${relativeTarget}: ok`);
    continue;
  }

  console.log(`[userscript-lint] ${relativeTarget}: ${messages.length} diagnostic(s)`);
  for (const message of messages) {
    if (message.severity === 2) {
      errorCount += 1;
    } else {
      warningCount += 1;
    }
    const level = message.severity === 2 ? "error" : "warn";
    const rule = message.ruleId ? ` ${message.ruleId}` : "";
    console.log(
      `${relativeTarget}:${message.line}:${message.column} ${level}${rule} ${message.message}`
    );
  }
}

console.log(`[userscript-lint] ${errorCount} error(s), ${warningCount} warning(s)`);
process.exit(errorCount || warningCount ? 1 : 0);
