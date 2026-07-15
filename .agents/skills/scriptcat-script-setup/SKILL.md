---
name: scriptcat-script-setup
description: Prepare ScriptCat in the dedicated portable Chromium MCP browser and write a repository userscript for real browser debugging. Use when checking ScriptCat readiness, repairing managed-MCP state, or updating a local userscript in the MCP profile.
---

# ScriptCat Script Setup

Use this skill before browser-debugging this repository's userscripts. The test browser is the dedicated portable Chromium MCP browser, not the user's normal profile.

## Extension Readiness

Use the managed ScriptCat tools through `mcp__chrome_devtools_scriptcat__`. The fixed ScriptCat extension ID is `ckchkcgpbkhleahkgkbiiikpcjdbopje`.

The MCP starts the portable Chromium and performs the managed-extension lifecycle in this order: it first loads or installs the extension, verifies the expected extension ID, calls `setUserScriptsAccess` to grant `userScripts` authorization, performs the second install/reload pass required after the grant, and then waits for the extension service worker and backend to become ready. Do not start Chrome separately or manipulate the profile.

1. Call `scriptcat_status` and confirm the expected ID, version, enabled status, `userScriptsAccessEnabled`, and service-worker readiness. Treat `false` or `null` for `userScriptsAccessEnabled` as not ready.
2. If access must change, call `set_extension_user_scripts_access` with that extension ID and the requested `enabled` value, then call `scriptcat_status` again.
3. If the extension is absent, has the wrong version, or remains unavailable, repair or rebuild the managed portable artifact with `scripts/remote/`; do not attempt in-profile installation.

The managed MCP is the only path for extension lifecycle and authorization. Do not use browser UI, `chrome://extensions/`, X11, `--load-extension`, `developerPrivate`, Preferences files, `install_extension`, or `reload_extension`.

## Concurrency

The dedicated ScriptCat profile is shared mutable state. Only one agent may operate it at a time. The MCP returns `PROFILE_BUSY` when another owner holds it. Finish script updates and runtime checks before another agent uses it; do not start parallel sessions against the same profile.

## Userscript Updates

Write only the target repository `*.user.js` required for the current task with `scriptcat_upsert_script`. The tool accepts a normalized path under this repository, not arbitrary filesystem paths. Use `scriptcat_list_scripts`, `scriptcat_get_script`, `scriptcat_set_enabled`, and `scriptcat_delete_script` for the corresponding managed operations.

When behavior matters, open a real page matching the script's `@match` metadata and confirm injection, console behavior, network requests, and the relevant interaction.

The user-facing `pnpm install:scriptcat -- <script.user.js>` workflow remains separate: it updates the normal browser via ScriptCat's VSCode sync port and does not configure or validate this MCP profile.
