---
name: scriptcat-script-setup
description: Prepare ScriptCat in the dedicated portable Chromium MCP browser and write a repository userscript for real browser debugging. Use when checking ScriptCat readiness, repairing managed-MCP state, or updating a local userscript in the MCP profile.
---

# ScriptCat Script Setup

Use this skill before browser-debugging this repository's userscripts. The test browser is the dedicated portable Chromium MCP browser, not the user's normal profile.

## Browser Provider

The Chromium provider and the ScriptCat MCP are independent products. The provider activates the executable at `~/.local/share/scriptcat-browser/current/chrome-linux/chrome`; the external runtime producer owns Chromium source checkout, patches, protocol tests, and compilation. The MCP at `~/.local/share/scriptcat-mcp/current/mcp/bin/chrome-devtools-mcp.js` launches that external executable.

Provider releases import a prebuilt runtime candidate with `scripts/remote/provider/import_runtime.py`, then package and install it using `browser/provider-contract.json`. The provider wrapper has no Chromium checkout or build command. MCP releases use `browser/mcp.lock.json` and the corresponding `scripts/remote/mcp/` commands. An MCP build, lock, manifest, build directory, test gate, or archive does not inspect or identify the provider. Browser integration is tested only after both products are installed. Updating the provider leaves MCP files and the ScriptCat profile intact; updating the MCP leaves the provider installation intact.

`~/.local/share/scriptcat-mcp` is the MCP data root for the activation journal and current managed ScriptCat tree. Runtime MCP readiness does not negotiate the browser protocol or validate the external browser's hash, commit, version, release root, or path. Archive SHA-256 and provenance checks remain part of each product's build, package, and install supply chain.

## Extension Readiness

Use the managed ScriptCat tools through `mcp__chrome_devtools_scriptcat__`. The fixed ScriptCat extension ID is `ckchkcgpbkhleahkgkbiiikpcjdbopje`.

The MCP keeps the managed extension in its fixed profile. A first startup performs one load with the expected extension ID and `userScripts` authorization, then emits `install_complete` once. A restored profile starts without loading the extension again. During a live session, only `userScriptsAccessEnabled: false` triggers `setUserScriptsAccess`; `true` requires no operation and `null` cannot establish readiness. The managed extension is protected after startup: generic install, reload, and uninstall operations are rejected, and its user-scripts access may only be set to `enabled=true` (repeated calls are idempotent). Do not start Chrome separately or manipulate the profile.

1. Call `scriptcat_status` and confirm the expected ID, version, enabled status, `userScriptsAccessEnabled`, service-worker readiness, and `startupAction`, `installCount`, and `accessRepairCount` diagnostics. A restored startup has no extension load; the first installation emits `install_complete` once.
2. When `userScriptsAccessEnabled` is `false`, call `set_extension_user_scripts_access` with that extension ID and `enabled=true`, then call `scriptcat_status` again. Passing `enabled=false` for the managed extension returns `MANAGED_EXTENSION_PROTECTED` and leaves the browser unchanged.
3. If the extension is absent, has the wrong version, or remains unavailable, repair or rebuild the managed portable artifact with `scripts/remote/`; do not attempt in-profile installation.

The managed MCP is the only path for extension lifecycle and authorization. `MANAGED_EXTENSION_PROTECTED` also covers generic `install_extension`, `reload_extension`, and `uninstall_extension` attempts against the fixed managed extension; do not retry those operations. Recover by preserving the managed extension, restoring access with `enabled=true`, or repairing/rebuilding the managed portable artifact when status reports an installation or readiness problem. Do not use browser UI, `chrome://extensions/`, X11, `--load-extension`, `developerPrivate`, Preferences files, `install_extension`, or `reload_extension` for managed-extension lifecycle changes.

## Concurrency

The dedicated ScriptCat profile is shared mutable state. Only one agent may operate it at a time. The MCP returns `PROFILE_BUSY` when another owner holds it. Finish script updates and runtime checks before another agent uses it; do not start parallel sessions against the same profile.

## Userscript Updates

Write only the target repository `*.user.js` required for the current task with `scriptcat_upsert_script`. The tool accepts a normalized path under this repository, not arbitrary filesystem paths. Use `scriptcat_list_scripts`, `scriptcat_get_script`, `scriptcat_set_enabled`, and `scriptcat_delete_script` for the corresponding managed operations.

When behavior matters, open a real page matching the script's `@match` metadata and confirm injection, console behavior, network requests, and the relevant interaction.

The user-facing `pnpm install:scriptcat -- <script.user.js>` workflow remains separate: it updates the normal browser via ScriptCat's VSCode sync port and does not configure or validate this MCP profile.
