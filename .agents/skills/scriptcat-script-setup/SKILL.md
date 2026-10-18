---
name: scriptcat-script-setup
description: Prepare the locally published ScriptCat extension in the dedicated Google Chrome MCP browser and write a repository userscript for real browser debugging. Use when checking ScriptCat readiness, publishing the local extension, or updating a local userscript in the MCP profile.
---

# ScriptCat Script Setup

Use this skill before browser-debugging this repository's userscripts. The test browser is a dedicated headless official Google Chrome instance, not the user's normal profile.

## Products And Publication

`browser/scriptcat` follows the official ScriptCat source and adds only the read-only `serviceWorker/script/getSource` message interface. The MCP uses that interface to read the original userscript source stored by ScriptCat. Publish the tested local build with:

```fish
uv run --project scripts --python 3.12 python scripts/scriptcat/publish.py
```

Publication stores extension data in `~/.local/share/scriptcat-extension` and atomically replaces the complete managed extension directory at `~/.local/share/scriptcat-extension/managed`. The fixed extension ID is `mihocogjodhedlmnebhfkiahldphcimj`.

The browser executable is the installed official Google Chrome at `/usr/bin/google-chrome`. The MCP build reads `--executable-path` from `.codex/config.toml`; this repository does not build or publish Chromium. The dedicated profile remains `~/.local/share/scriptcat-mcp/chromium-profile`, preserving scripts, GM storage, and login state. MCP configuration sets `HTTP_PROXY` and `HTTPS_PROXY` to `http://127.0.0.1:7891` and grants repository file access with `--workspace=/home/bluebird/git/scriptcat`. Upstream filesystem roots validation remains active.

ScriptCat MCP is a local three-stage product. Commands in `scripts/mcp/` install dependencies with `PUPPETEER_SKIP_DOWNLOAD=true`, build and test from `browser/chrome-devtools-mcp`, store build state in `~/.local/share/scriptcat-mcp-build`, create a schema 5 archive, and install it under `~/.local/share/scriptcat-mcp`. Build validates the bundled candidate runtime with a real temporary-profile shared-browser E2E. Install materializes the new release, asks the old runtime to enter an exclusive handoff while retaining abstract-socket ownership, switches `current` and `previous`, and then commits the handoff. A successful broker commit is the irreversible activation point: later journal cleanup failures preserve the new links, while failures before commit abort the handoff and restore the old links. A running shared broker without handoff support fails safe instead of falling back to `stop`; for that one-time upgrade boundary, end active sessions, run `scripts/mcp/control.py stop` explicitly, and retry install. The active executable remains `~/.local/share/scriptcat-mcp/current/mcp/bin/chrome-devtools-mcp.js`; all MCP publication work executes against the local checkout and local release roots. The installed shared mode uses one persistent broker for the fixed profile and browser process. Each root or subagent connects through its own stdio proxy and keeps an independent MCP session and `McpContext` while sharing the broker's browser. Closing a proxy does not end that browser lifecycle.

The broker launches the configured browser executable with the fixed profile. At the start of every new browser lifecycle, it enables developer mode through Chrome’s extension settings UI, uses standard `Extensions.loadUnpacked` to load or refresh the managed extension directory, and verifies the returned extension ID. It then checks and grants userScripts access through Chrome’s extension settings UI. If the grant changes, it loads the directory again so the service worker receives the updated API availability. ScriptCat readiness probes complete initialization. The operation is content-driven: it does not compare or assume an extension version, and an already registered extension is still refreshed. Disconnecting or restarting a proxy does not refresh the extension because it does not start a new browser lifecycle. Browser installation, extension publication, and MCP publication remain independent.

## Extension Readiness

Use the managed ScriptCat tools through `mcp__chrome_devtools_scriptcat__`.

1. At the start of every MCP session, call `scriptcat_status` and confirm the extension ID, enabled state, `userScriptsAccessEnabled: true`, and service-worker readiness.
2. Treat any other `userScriptsAccessEnabled` value as a browser lifecycle loading failure. Inspect the MCP and extension state; do not call a permission setter or perform an extra reload as recovery.
3. When the managed directory is missing or corrupt, its manifest is invalid, or the extension remains unavailable, publish `browser/scriptcat` with `scripts/scriptcat/publish.py` to atomically repair the fixed directory. End active MCP sessions, then run `uv run --project scripts --python 3.12 python scripts/mcp/control.py stop` as an explicit maintenance action; the command reuses the complete configured browser arguments and rejects remaining active clients. Let the next proxy start a new browser lifecycle, then repeat the status check. MCP release installation performs its own atomic handoff and never uses this maintenance stop.

`scriptcat_status` is observational. MCP lifecycle initialization owns extension content refresh, userScripts authorization, and the conditional worker refresh.

## Userscript Updates

Write only the target repository `*.user.js` required for the current task with `scriptcat_upsert_script`. The tool accepts a normalized path under this repository, not arbitrary filesystem paths, and disables ScriptCat's background update check for each script it manages so an external `@updateURL` cannot replace the repository source. Use `scriptcat_list_scripts`, `scriptcat_get_script`, `scriptcat_set_enabled`, and `scriptcat_delete_script` for the corresponding operations.

When behavior matters, open a real page matching the script's `@match` metadata and confirm injection, console behavior, network requests, and the relevant interaction.

The user-facing `pnpm install:scriptcat -- <script.user.js>` workflow remains separate: it updates the normal browser via ScriptCat's VSCode sync port and does not configure or validate this MCP profile.
