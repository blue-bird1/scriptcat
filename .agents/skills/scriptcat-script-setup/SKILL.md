---
name: scriptcat-script-setup
description: Prepare the locally published ScriptCat extension in the dedicated Google Chrome MCP browser and write a repository userscript for real browser debugging. Use when checking ScriptCat readiness, publishing the local extension, or updating a local userscript in the MCP profile.
---

# ScriptCat script setup

Use the dedicated headless browser, not the user’s daily browser. Before operating it, read `../../../docs/development/scriptcat-browser.md` for the configured runtime, profile, proxy and broker ownership.

1. Begin each MCP session with `scriptcat_status`. Require the managed extension to be enabled and userScripts, service worker and backend transport to be ready.
2. If readiness fails, inspect lifecycle initialization and the managed directory. Do not grant permission or reload the extension as a shortcut.
3. Install or update only the target repository userscript with `scriptcat_upsert_script`. Use ScriptCat tools for script metadata, source, enablement and deletion.
4. Open a real matching page and verify injection, UI, console, requests and the requested interaction. Verify writes by independently reading their persisted result.
5. After build, tests and commit, install each changed root userscript into the daily browser with `pnpm install:scriptcat -- <script.user.js>`.

For a missing or corrupt managed directory, follow `../../../docs/development/scriptcat-extension.md` to publish the extension and start a new lifecycle during explicit maintenance. Close active sessions before the controlled stop; never signal or manually replace the browser.

When publishing the MCP itself, follow the separate build, package and install procedure in `../../../docs/development/mcp-release.md`. MCP and extension publication are independent; normal MCP activation uses broker handoff, not stop.
