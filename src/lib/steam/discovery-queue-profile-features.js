const PROFILE_PROGRESS_ENDPOINT =
  "https://api.steampowered.com/IPlayerService/GetAchievementsProgress/v1/";

function readApplicationConfig() {
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
  } catch {
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

export function createProfileFeaturesLimitedReader() {
  const cache = new Map();
  let requestChain = Promise.resolve();
  let requestGeneration = 0;
  let requestsBlocked = false;

  async function request(appId, generation) {
    if (requestsBlocked || generation !== requestGeneration) {
      return undefined;
    }

    const credentials = readApplicationConfig();
    if (!credentials) {
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

    try {
      const response = await fetch(url, {
        method: "POST",
        body,
      });
      if (generation !== requestGeneration) {
        return undefined;
      }
      if (response.status === 429) {
        requestsBlocked = true;
        return undefined;
      }
      return response.ok
        ? parseProfileFeaturesLimited(await response.json(), appId)
        : undefined;
    } catch {
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
    clear() {
      requestGeneration += 1;
      cache.clear();
      requestChain = Promise.resolve();
      requestsBlocked = false;
    },
  };
}
