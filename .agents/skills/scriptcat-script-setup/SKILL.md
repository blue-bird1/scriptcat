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

The browser provider and ScriptCat MCP are separate remote three-stage products. Provider commands in `scripts/remote/provider/` build, package, and install Chromium; provider installation activates `~/.local/share/scriptcat-browser/current/chrome-linux/chrome`. MCP commands in `scripts/remote/mcp/` build, package, and install only the MCP; MCP installation activates `~/.local/share/scriptcat-mcp/current/mcp/bin/chrome-devtools-mcp.js`. Their locks, component identities, archives, and release directories remain independent.

The MCP launches the provider executable with the fixed profile and receives the managed extension directory from configuration. It reads the extension manifest from that directory at runtime and does not assume an extension version or read extension installation transactions. Publishing the extension leaves provider and MCP installations unchanged; provider and MCP releases do not build, archive, install, or publish the extension.

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
