import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REGULAR_SCRIPT_UPDATE_ALARM } from "@App/app/managed_mcp";
import { initRegularUpdateCheck, onRegularUpdateCheckAlarm } from "./regular_updatecheck";
import type { SystemConfig } from "@App/pkg/config/config";
import type { ScriptService } from "./script";

describe("managed MCP regular updates", () => {
  let clearAlarm = vi.fn();
  let createAlarm = vi.fn();

  beforeEach(() => {
    vi.stubEnv("SC_MANAGED_MCP", "true");
    clearAlarm = vi.fn();
    createAlarm = vi.fn();
    vi.stubGlobal("chrome", {
      ...chrome,
      alarms: {
        clear: clearAlarm,
        create: createAlarm,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("clears a persisted regular update alarm without checking or silently installing scripts", async () => {
    const systemConfig = {
      getCheckScriptUpdateCycle: vi.fn().mockResolvedValue(60),
    } as unknown as SystemConfig;
    const scriptService = {
      checkScriptUpdate: vi.fn(),
    } as unknown as ScriptService;

    await initRegularUpdateCheck(systemConfig);
    const result = await onRegularUpdateCheckAlarm(systemConfig, scriptService);

    expect(clearAlarm).toHaveBeenCalledWith(REGULAR_SCRIPT_UPDATE_ALARM);
    expect(createAlarm).not.toHaveBeenCalled();
    expect(scriptService.checkScriptUpdate).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
