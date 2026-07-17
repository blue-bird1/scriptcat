---
name: scriptcat-script-setup
description: Prepare the locally published ScriptCat extension in the dedicated portable Chromium MCP browser and write a repository userscript for real browser debugging. Use when checking ScriptCat readiness, publishing the local extension, or updating a local userscript in the MCP profile.
---

# ScriptCat Script Setup

Use this skill before browser-debugging this repository's userscripts. The test browser is the dedicated portable Chromium MCP browser, not the user's normal profile.

## Products And Publication

`browser/scriptcat` follows the official ScriptCat source and adds only the read-only `serviceWorker/script/getSource` message interface. The MCP uses that interface to read the original userscript source stored by ScriptCat. Publish the tested local build with:

```fish
uv run --project scripts --python 3.12 python scripts/scriptcat/publish.py
```

Publication stores extension data in `~/.local/share/scriptcat-extension` and atomically replaces the complete managed extension directory at `~/.codex/chrome-extensions/scriptcat/managed`. The fixed extension ID is `oepcbpjafionmhhelohlfhlmlaciclhc`.

The browser provider is the only remote build product. Its `scripts/remote/provider/` build and package stages use `192.168.50.8` through `wg0` to compile, test, and package Chromium; its offline local install stage activates `~/.local/share/scriptcat-browser/current/chrome-linux/chrome`.

ScriptCat MCP is a local three-stage product. Commands in `scripts/mcp/` build and test from `browser/chrome-devtools-mcp`, store build state in `~/.local/share/scriptcat-mcp-build`, create a schema 5 archive, and install it under `~/.local/share/scriptcat-mcp`. The active executable remains `~/.local/share/scriptcat-mcp/current/mcp/bin/chrome-devtools-mcp.js`; all MCP publication work executes against the local checkout and local release roots.

The MCP launches the provider executable with the fixed profile and receives the managed extension directory from configuration. During every browser lifecycle, it invokes trusted `Extensions.loadUnpacked` with that directory, the fixed `expectedId`, and `userScriptsAccess: true`. This atomically loads or refreshes the current directory contents and grants userscript access before the first extension service worker starts. The operation is content-driven: it does not compare or assume an extension version, and an already registered extension is still refreshed. The MCP does not use a separate permission setter or an additional reload. The browser provider requires no change for this flow; extension, provider, and MCP publication remain independent.

## Extension Readiness

Use the managed ScriptCat tools through `mcp__chrome_devtools_scriptcat__`.

1. Call `scriptcat_status` and confirm the extension ID, enabled state, `userScriptsAccessEnabled: true`, and service-worker readiness.
2. Treat any other `userScriptsAccessEnabled` value as a browser lifecycle loading failure. Inspect the MCP and extension state; do not call a permission setter or perform an extra reload as recovery.
3. When the managed directory is missing or corrupt, its manifest is invalid, or the extension remains unavailable, publish `browser/scriptcat` with `scripts/scriptcat/publish.py` to atomically repair the fixed directory, start a new browser lifecycle, then repeat the status check.

`scriptcat_status` is observational. The MCP's lifecycle `Extensions.loadUnpacked` call owns both content refresh and the atomic permission grant. The provider only supplies the Chromium executable.

## Userscript Updates

Write only the target repository `*.user.js` required for the current task with `scriptcat_upsert_script`. The tool accepts a normalized path under this repository, not arbitrary filesystem paths, and disables ScriptCat's background update check for each script it manages so an external `@updateURL` cannot replace the repository source. Use `scriptcat_list_scripts`, `scriptcat_get_script`, `scriptcat_set_enabled`, and `scriptcat_delete_script` for the corresponding operations.

When behavior matters, open a real page matching the script's `@match` metadata and confirm injection, console behavior, network requests, and the relevant interaction.

The user-facing `pnpm install:scriptcat -- <script.user.js>` workflow remains separate: it updates the normal browser via ScriptCat's VSCode sync port and does not configure or validate this MCP profile.
