---
name: scriptcat-script-setup
description: Prepare ScriptCat in the dedicated portable Chromium MCP browser and write a repository userscript for real browser debugging. Use when checking ScriptCat readiness, repairing managed-MCP state, or updating a local userscript in the MCP profile.
---

# ScriptCat Script Setup

Use this skill before browser-debugging this repository's userscripts. The test browser is the dedicated portable Chromium MCP browser, not the user's normal profile.

## Browser Provider

The Chromium provider and the ScriptCat MCP are independent products. The provider owns browser patches, protocol tests, and the executable at `~/.local/share/scriptcat-browser/current/chrome-linux/chrome`. The MCP at `~/.local/share/scriptcat-mcp/current/mcp/bin/chrome-devtools-mcp.js` launches that external executable.

Provider releases use `browser/provider.lock.json` and the explicit `scripts/remote/provider/` build, package, and install commands. The provider component identity derives only from its lock, build schema, and browser inputs; the parent repository `HEAD` is excluded. A persistent Chromium checkout with the same verified base and patch digest activates the existing component through a zero-write path that skips `gclient`, `gn`, and Ninja. A changed patch digest incrementally updates only the real differences before normal Ninja dependency-driven compilation and protocol tests. Package release identity derives from the component and runtime inventory.

MCP releases use `browser/mcp.lock.json` and the corresponding `scripts/remote/mcp/` commands. MCP product identity derives from its own product inputs and excludes the parent repository `HEAD`; its build, lock, manifest, build directory, test gate, and archive remain independent of provider identity. Browser integration is tested only after both products are installed. Updating the provider leaves MCP files and the ScriptCat profile intact; updating the MCP leaves the provider installation intact.

`~/.local/share/scriptcat-mcp` stores MCP releases and installer transaction state. Installation atomically switches its `current` release and publishes the managed extension at `~/.codex/chrome-extensions/scriptcat/<version>` while preserving the fixed profile. Runtime MCP readiness receives that published extension path and does not read installer transaction state, negotiate the browser protocol, or validate the external browser's hash, commit, version, release root, or path. Archive SHA-256 and provenance checks remain part of each product's build, package, and install supply chain.

## Extension Readiness

Use the managed ScriptCat tools through `mcp__chrome_devtools_scriptcat__`. The fixed ScriptCat extension ID is `ckchkcgpbkhleahkgkbiiikpcjdbopje`.

The MCP uses the published managed extension with its fixed profile. During a live session, only `userScriptsAccessEnabled: false` triggers `setUserScriptsAccess`; `true` requires no operation and `null` cannot establish readiness. The managed extension is protected: generic install, reload, and uninstall operations are rejected, and its user-scripts access may only be set to `enabled=true` (repeated calls are idempotent). Do not start Chrome separately or manipulate the profile.

1. Call `scriptcat_status` and confirm the expected ID, version, enabled status, `userScriptsAccessEnabled`, and service-worker readiness.
2. When `userScriptsAccessEnabled` is `false`, call `set_extension_user_scripts_access` with that extension ID and `enabled=true`, then call `scriptcat_status` again. Passing `enabled=false` for the managed extension returns `MANAGED_EXTENSION_PROTECTED` and leaves the browser unchanged.
3. If the extension is absent from the fixed profile, MCP loads the published managed path automatically. Repair or rebuild the managed portable artifact with `scripts/remote/` only when that path has the wrong version or the extension remains unavailable.

The managed MCP is the only path for extension lifecycle and authorization. `MANAGED_EXTENSION_PROTECTED` also covers generic `install_extension`, `reload_extension`, and `uninstall_extension` attempts against the fixed managed extension; do not retry those operations. Recover by preserving the managed extension, restoring access with `enabled=true`, or repairing/rebuilding the managed portable artifact when status reports an installation or readiness problem. Do not use browser UI, `chrome://extensions/`, X11, `--load-extension`, `developerPrivate`, Preferences files, `install_extension`, or `reload_extension` for managed-extension lifecycle changes.

## Userscript Updates

Write only the target repository `*.user.js` required for the current task with `scriptcat_upsert_script`. The tool accepts a normalized path under this repository, not arbitrary filesystem paths. Use `scriptcat_list_scripts`, `scriptcat_get_script`, `scriptcat_set_enabled`, and `scriptcat_delete_script` for the corresponding managed operations.

When behavior matters, open a real page matching the script's `@match` metadata and confirm injection, console behavior, network requests, and the relevant interaction.

The user-facing `pnpm install:scriptcat -- <script.user.js>` workflow remains separate: it updates the normal browser via ScriptCat's VSCode sync port and does not configure or validate this MCP profile.
