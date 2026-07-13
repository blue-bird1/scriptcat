import type { Server } from "@Packages/message/server";

export const REGULAR_SCRIPT_UPDATE_ALARM = "checkScriptUpdate";
export const REGULAR_EXTENSION_UPDATE_ALARM = "checkUpdate";
export const MANAGED_MCP_ROUTE_NAME = "managed";
export const MANAGED_MCP_PING_ACTION = "ping";
export const MANAGED_MCP_PING_RESPONSE = Object.freeze({ managed: true });

export const isManagedMcp = () => process.env.SC_MANAGED_MCP === "true";

export function registerManagedMcpRoutes(api: Server) {
  if (!isManagedMcp()) return;

  api.group(MANAGED_MCP_ROUTE_NAME).on(MANAGED_MCP_PING_ACTION, () => MANAGED_MCP_PING_RESPONSE);
}
