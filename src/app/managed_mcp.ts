import type { Server } from "@Packages/message/server";

export const REGULAR_SCRIPT_UPDATE_ALARM = "checkScriptUpdate";
export const REGULAR_EXTENSION_UPDATE_ALARM = "checkUpdate";
export const MANAGED_MCP_ROUTE_NAME = "managed";
export const MANAGED_MCP_PING_ACTION = "ping";
export const MANAGED_MCP_PING_RESPONSE = Object.freeze({ managed: true });
export const EXTENSION_INSTALL_REASON = "install";
export const EXTENSION_UPDATE_REASON = "update";
export const EXTENSION_CHROME_UPDATE_REASON = "chrome_update";
export const USER_SCRIPTS_ACCESS_RECOVERY_INTERVAL_MS = 500;

export const isManagedMcp = () => process.env.SC_MANAGED_MCP === "true";

export function registerManagedMcpRoutes(api: Server) {
  if (!isManagedMcp()) return;

  api.group(MANAGED_MCP_ROUTE_NAME).on(MANAGED_MCP_PING_ACTION, () => MANAGED_MCP_PING_RESPONSE);
}

export function registerManagedMcpInstallPage(openInstallPage: () => void) {
  if (!isManagedMcp()) return;

  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === EXTENSION_INSTALL_REASON) openInstallPage();
  });
}

export function shouldShowUserScriptsWarning(isUserScriptsAvailable: boolean) {
  return !isUserScriptsAvailable && !isManagedMcp();
}

export function recoverMissingUserScriptsAccess(isUserScriptsAvailable: () => boolean) {
  if (isUserScriptsAvailable()) return;

  const intervalId = setInterval(async () => {
    if (!isUserScriptsAvailable()) {
      try {
        const scriptId = `undefined-test-${Date.now()}`;
        await chrome.userScripts.register([
          {
            id: scriptId,
            js: [{ code: "void 0;" }],
            matches: ["https://not-found.scriptcat.org/"],
            world: "USER_SCRIPT",
          },
        ]);
        await chrome.userScripts.unregister({ ids: [scriptId] });
      } catch (_error) {
        return;
      }
    }
    clearInterval(intervalId);
    chrome.runtime.reload();
  }, USER_SCRIPTS_ACCESS_RECOVERY_INTERVAL_MS);
}
