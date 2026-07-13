import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EventEmitter from "eventemitter3";
import { Server } from "@Packages/message/server";
import { MockMessage } from "@Packages/message/mock_message";
import { initTestEnv } from "@Tests/utils";
import { registerManagedMcpRoutes } from "./managed_mcp";

initTestEnv();

const managedPingRoute = "managed/ping";
const managedPingAction = `serviceWorker/${managedPingRoute}`;

const createServiceWorkerServer = () => {
  const message = new MockMessage(new EventEmitter<string, any>());
  return { message, server: new Server("serviceWorker", message) };
};

describe("managed MCP ping route", () => {
  beforeEach(() => {
    vi.stubEnv("SC_MANAGED_MCP", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the managed health response through the service worker", async () => {
    const { message, server } = createServiceWorkerServer();
    registerManagedMcpRoutes(server);

    await expect(message.sendMessage({ action: managedPingAction })).resolves.toEqual({
      code: 0,
      data: { managed: true },
    });
  });

  it("does not register the managed health route outside managed builds", async () => {
    vi.stubEnv("SC_MANAGED_MCP", "false");
    const { message, server } = createServiceWorkerServer();
    registerManagedMcpRoutes(server);

    await expect(message.sendMessage({ action: managedPingAction })).resolves.toEqual({
      code: -1,
      message: `no such api ${managedPingRoute}`,
    });
  });
});
