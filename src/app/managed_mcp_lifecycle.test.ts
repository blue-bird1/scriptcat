import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXTENSION_CHROME_UPDATE_REASON,
  EXTENSION_INSTALL_REASON,
  EXTENSION_UPDATE_REASON,
  USER_SCRIPTS_ACCESS_RECOVERY_INTERVAL_MS,
  recoverMissingUserScriptsAccess,
  registerManagedMcpInstallPage,
  shouldShowUserScriptsWarning,
} from "./managed_mcp";

const flushAsyncWork = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("managed MCP lifecycle", () => {
  const onInstalledListeners: Array<(details: chrome.runtime.InstalledDetails) => void> = [];
  let registerUserScript: ReturnType<typeof vi.fn>;
  let unregisterUserScript: ReturnType<typeof vi.fn>;
  let reloadExtension: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("SC_MANAGED_MCP", "true");
    vi.useFakeTimers();
    registerUserScript = vi.fn();
    unregisterUserScript = vi.fn();
    reloadExtension = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: {
        onInstalled: {
          addListener(listener: (details: chrome.runtime.InstalledDetails) => void) {
            onInstalledListeners.push(listener);
          },
        },
        reload: reloadExtension,
      },
      userScripts: {
        register: registerUserScript,
        unregister: unregisterUserScript,
      },
    });
  });

  afterEach(() => {
    onInstalledListeners.length = 0;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("opens the original install completion page once for the real install reason", () => {
    const openInstallPage = vi.fn();

    registerManagedMcpInstallPage(openInstallPage);
    onInstalledListeners[0]({ reason: EXTENSION_INSTALL_REASON });
    onInstalledListeners[0]({ reason: EXTENSION_UPDATE_REASON });
    onInstalledListeners[0]({ reason: EXTENSION_CHROME_UPDATE_REASON });

    expect(openInstallPage).toHaveBeenCalledTimes(1);
  });

  it("keeps a missing userScripts access probe without the managed warning", async () => {
    registerUserScript.mockRejectedValueOnce(new Error());
    registerUserScript.mockResolvedValueOnce(undefined);
    unregisterUserScript.mockResolvedValueOnce(undefined);

    expect(shouldShowUserScriptsWarning(false)).toBe(false);
    recoverMissingUserScriptsAccess(() => false);

    await vi.advanceTimersByTimeAsync(USER_SCRIPTS_ACCESS_RECOVERY_INTERVAL_MS);
    await flushAsyncWork();
    expect(reloadExtension).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(USER_SCRIPTS_ACCESS_RECOVERY_INTERVAL_MS);
    await flushAsyncWork();
    expect(registerUserScript).toHaveBeenCalledTimes(2);
    expect(unregisterUserScript).toHaveBeenCalledTimes(1);
    expect(reloadExtension).toHaveBeenCalledTimes(1);
  });

  it("does not start recovery after an atomic userScripts installation", async () => {
    recoverMissingUserScriptsAccess(() => true);

    await vi.advanceTimersByTimeAsync(USER_SCRIPTS_ACCESS_RECOVERY_INTERVAL_MS);
    await flushAsyncWork();
    expect(registerUserScript).not.toHaveBeenCalled();
    expect(reloadExtension).not.toHaveBeenCalled();
  });
});
