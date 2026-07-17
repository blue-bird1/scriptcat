---
name: scriptcat-script-setup
description: Prepare the locally published managed ScriptCat extension in the dedicated portable Chromium MCP browser and write a repository userscript for real browser debugging. Use when checking ScriptCat readiness, restoring managed-extension access, publishing the local extension, or updating a local userscript in the MCP profile.
---

# ScriptCat Script Setup

Use this skill before browser-debugging this repository's userscripts. The test browser is the dedicated portable Chromium MCP browser, not the user's normal profile.

## Products And Publication

`browser/scriptcat` is the local ScriptCat extension submodule. Publish its tested local build with:

```fish
uv run --project scripts --python 3.12 python scripts/scriptcat/publish.py
```

Publication stores extension data in `~/.local/share/scriptcat-extension` and atomically provides the managed extension at `~/.codex/chrome-extensions/scriptcat/managed`. The fixed extension ID is `oepcbpjafionmhhelohlfhlmlaciclhc`.

The browser provider is the only remote build product. Its `scripts/remote/provider/` build and package stages use `192.168.50.8` through `wg0` to compile, test, and package Chromium; its offline local install stage activates `~/.local/share/scriptcat-browser/current/chrome-linux/chrome`.

ScriptCat MCP is a local three-stage product. Commands in `scripts/mcp/` build and test from `browser/chrome-devtools-mcp`, store build state in `~/.local/share/scriptcat-mcp-build`, create a schema 5 archive, and install it under `~/.local/share/scriptcat-mcp`. The active executable remains `~/.local/share/scriptcat-mcp/current/mcp/bin/chrome-devtools-mcp.js`; all MCP publication work executes against the local checkout and local release roots.

The MCP launches the provider executable with the fixed profile and receives the managed extension directory from configuration. It reads the extension manifest from that directory at runtime and does not assume an extension version or read extension installation transactions. Extension, provider, and MCP publication remain independent.

## Extension Readiness

Use the managed ScriptCat tools through `mcp__chrome_devtools_scriptcat__`.

1. Call `scriptcat_status` and confirm extension ID, enabled state, `userScriptsAccessEnabled`, and service-worker readiness.
2. When `userScriptsAccessEnabled` is `false`, call `set_extension_user_scripts_access` with ID `oepcbpjafionmhhelohlfhlmlaciclhc` and `enabled=true`, then call `scriptcat_status` again.
3. When the managed directory is missing or corrupt, its manifest is invalid, or the extension remains unavailable, publish `browser/scriptcat` with `scripts/scriptcat/publish.py` to repair the fixed directory, then repeat the status check.

The managed extension accepts only `enabled=true` for user-scripts access; repeated calls are idempotent. Generic extension lifecycle operations return `MANAGED_EXTENSION_PROTECTED`. Managed-extension recovery preserves the fixed profile, restores access when disabled, and republishes the local extension when the managed contents, manifest, or extension readiness is invalid.

## Extension ID Migration

The fixed ID `oepcbpjafionmhhelohlfhlmlaciclhc` starts with independent extension storage. Do not migrate userscripts, settings, or storage from the former ID `ckchkcgpbkhleahkgkbiiikpcjdbopje`. Grant user-scripts access again for the new ID and write the required repository scripts with `scriptcat_upsert_script`. After status, CRUD, and real-page injection succeed under the new ID, uninstall the former ID and move `~/.codex/chrome-extensions/scriptcat/v1.3.2` to `/backup`.

## Userscript Updates

Write only the target repository `*.user.js` required for the current task with `scriptcat_upsert_script`. The tool accepts a normalized path under this repository, not arbitrary filesystem paths. Use `scriptcat_list_scripts`, `scriptcat_get_script`, `scriptcat_set_enabled`, and `scriptcat_delete_script` for the corresponding managed operations.

When behavior matters, open a real page matching the script's `@match` metadata and confirm injection, console behavior, network requests, and the relevant interaction.

The user-facing `pnpm install:scriptcat -- <script.user.js>` workflow remains separate: it updates the normal browser via ScriptCat's VSCode sync port and does not configure or validate this MCP profile.
