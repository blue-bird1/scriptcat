const PROFILE_PROGRESS_ENDPOINT =
  "https://api.steampowered.com/IPlayerService/GetAchievementsProgress/v1/";

function readApplicationConfig(logger) {
  const applicationConfig = document.getElementById("application_config");
  if (!(applicationConfig instanceof HTMLElement)) {
    return undefined;
  }

  try {
    const userInfo = JSON.parse(applicationConfig.dataset.userinfo ?? "");
    const storeUserConfig = JSON.parse(
      applicationConfig.dataset.store_user_config ?? "",
    );
    const steamId = userInfo?.steamid;
    const accessToken = storeUserConfig?.webapi_token;
    return typeof steamId === "string" &&
      /^\d{17}$/.test(steamId) &&
      typeof accessToken === "string" &&
      accessToken
      ? { steamId, accessToken }
      : undefined;
  } catch (error) {
    logger?.error("credentials.parse.error", error);
    return undefined;
  }
}

function parseProfileFeaturesLimited(payload, appId) {
  const progress = payload?.response?.achievement_progress;
  if (!Array.isArray(progress)) {
    return undefined;
  }

  const matching = progress.find((entry) => String(entry?.appid) === appId);
  if (!matching || typeof matching !== "object") {
    return undefined;
  }
  if (!Object.hasOwn(matching, "vetted")) {
    return true;
  }
  return typeof matching.vetted === "boolean" ? !matching.vetted : undefined;
}

export function createProfileFeaturesLimitedReader({ logger } = {}) {
  const cache = new Map();
  const diagnostics = new Map();
  let requestChain = Promise.resolve();
  let requestGeneration = 0;
  let requestsBlocked = false;

  async function request(appId, generation) {
    if (requestsBlocked || generation !== requestGeneration) {
      diagnostics.set(appId, {
        kind: "unavailable",
        reason: requestsBlocked ? "rate-limited" : "generation-cancelled",
      });
      logger?.debug("request.skipped", {
        appId,
        generation,
        reason: requestsBlocked ? "rate-limited" : "generation-cancelled",
        requestGeneration,
      });
      return undefined;
    }

    const credentials = readApplicationConfig(logger);
    if (!credentials) {
      diagnostics.set(appId, {
        kind: "unavailable",
        reason: "credentials-unavailable",
      });
      logger?.warn("request.skipped", {
        appId,
        reason: "credentials-unavailable",
      });
      return undefined;
    }

    const url = new URL(PROFILE_PROGRESS_ENDPOINT);
    url.searchParams.set("access_token", credentials.accessToken);
    const body = new FormData();
    body.set(
      "input_json",
      JSON.stringify({
        steamid: credentials.steamId,
        language:
          typeof window.g_strLanguage === "string" && window.g_strLanguage
            ? window.g_strLanguage
            : "english",
        appids: [Number(appId)],
        include_unvetted_apps: true,
      }),
    );

    const startedAt = performance.now();
    logger?.debug("request.started", { appId, generation });
    try {
      const response = await fetch(url, {
        method: "POST",
        body,
      });
      if (generation !== requestGeneration) {
        diagnostics.set(appId, {
          kind: "unavailable",
          reason: "generation-cancelled",
        });
        logger?.info("request.cancelled", {
          appId,
          durationMs: performance.now() - startedAt,
          generation,
          requestGeneration,
          stage: "response",
        });
        return undefined;
      }
      if (response.status === 429) {
        requestsBlocked = true;
        diagnostics.set(appId, {
          kind: "http",
          status: response.status,
          statusText: response.statusText,
        });
        logger?.warn("request.rate-limited", {
          appId,
          durationMs: performance.now() - startedAt,
          status: response.status,
          statusText: response.statusText,
        });
        return undefined;
      }
      if (!response.ok) {
        diagnostics.set(appId, {
          kind: "http",
          status: response.status,
          statusText: response.statusText,
        });
        logger?.warn("request.http-error", {
          appId,
          durationMs: performance.now() - startedAt,
          status: response.status,
          statusText: response.statusText,
        });
        return undefined;
      }
      const value = parseProfileFeaturesLimited(await response.json(), appId);
      if (value === undefined) {
        diagnostics.set(appId, {
          kind: "invalid-response",
          reason: "profile-status-unresolved",
        });
      } else {
        diagnostics.delete(appId);
      }
      logger?.debug("request.completed", {
        appId,
        durationMs: performance.now() - startedAt,
        status: response.status,
        value,
      });
      return value;
    } catch (error) {
      diagnostics.set(appId, { error, kind: "exception" });
      logger?.error("request.error", error, {
        appId,
        durationMs: performance.now() - startedAt,
      });
      return undefined;
    }
  }

  return {
    get(appId) {
      let statusPromise = cache.get(appId);
      if (!statusPromise) {
        const generation = requestGeneration;
        statusPromise = requestChain.then(() => request(appId, generation));
        requestChain = statusPromise.then(
          () => undefined,
          () => undefined,
        );
        cache.set(appId, statusPromise);
      }
      return statusPromise;
    },
    getDiagnostic(appId) {
      return diagnostics.get(appId);
    },
    clear() {
      requestGeneration += 1;
      logger?.info("generation.cleared", { requestGeneration });
      cache.clear();
      diagnostics.clear();
      requestChain = Promise.resolve();
      requestsBlocked = false;
    },
  };
}
