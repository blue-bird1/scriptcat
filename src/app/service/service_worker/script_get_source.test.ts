import { beforeEach, describe, expect, it, vi } from "vitest";
import EventEmitter from "eventemitter3";
import { initTestEnv } from "@Tests/utils";
import { ScriptDAO } from "@App/app/repo/scripts";
import { SystemConfig } from "@App/pkg/config/config";
import { MessageQueue } from "@Packages/message/message_queue";
import { MockMessage } from "@Packages/message/mock_message";
import { Server } from "@Packages/message/server";
import { createMockOPFS } from "@App/app/repo/test-helpers";
import type { ResourceService } from "./resource";
import { ScriptService } from "./script";
import type { ValueService } from "./value";

const GET_SOURCE_ACTION = "serviceWorker/script/getSource";
const MCP_CAPABILITY_PROBE_UUID = "__scriptcat_mcp_capability_probe__";

initTestEnv();

beforeEach(() => createMockOPFS());

const createService = () => {
  const message = new MockMessage(new EventEmitter<string, any>());
  const messageQueue = new MessageQueue();
  const systemConfig = new SystemConfig(messageQueue);
  const service = new ScriptService(
    systemConfig,
    new Server("serviceWorker", message).group("script"),
    messageQueue,
    {} as ValueService,
    { updateResourceByTypes: async () => {} } as unknown as ResourceService,
    new ScriptDAO()
  );
  service.scriptCodeDAO.useCache = false;
  service.listenerScriptInstall = vi.fn();
  systemConfig.getCheckScriptUpdateCycle = vi.fn().mockResolvedValue(0);
  return { message, service };
};

describe(GET_SOURCE_ACTION, () => {
  it("returns the stored raw userscript source through the service-worker message route", async () => {
    const originalAlarms = chrome.alarms;
    Object.defineProperty(chrome, "alarms", {
      configurable: true,
      value: { clear: vi.fn().mockResolvedValue(true) },
    });
    const { message, service } = createService();

    try {
      service.init();
      const uuid = "raw-source-contract-script";
      const source = `// ==UserScript==\n// @name ${uuid}\n// ==/UserScript==`;
      await service.scriptCodeDAO.save({ uuid, code: source });

      await expect(message.sendMessage({ action: GET_SOURCE_ACTION, data: uuid })).resolves.toEqual({
        code: 0,
        data: source,
      });
    } finally {
      Object.defineProperty(chrome, "alarms", { configurable: true, value: originalAlarms });
    }
  });

  it("returns exact null for the MCP capability-probe sentinel", async () => {
    const originalAlarms = chrome.alarms;
    Object.defineProperty(chrome, "alarms", {
      configurable: true,
      value: { clear: vi.fn().mockResolvedValue(true) },
    });
    const { message, service } = createService();

    try {
      service.init();

      await expect(
        message.sendMessage({ action: GET_SOURCE_ACTION, data: MCP_CAPABILITY_PROBE_UUID })
      ).resolves.toEqual({ code: 0, data: null });
    } finally {
      Object.defineProperty(chrome, "alarms", { configurable: true, value: originalAlarms });
    }
  });
});
