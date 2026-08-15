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
  } catch (error) {
    console.error("[Steam 探索队列] 无法解析页面中的 Steam 用户配置，跳过受限个人资料功能筛选", error);
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
        console.warn("[Steam 探索队列] Steam 限制了个人资料功能查询，本轮不再继续请求");
        return undefined;
      }
      if (!response.ok) {
        console.error(
          `[Steam 探索队列] 查询 App ${appId} 的个人资料功能失败：HTTP ${response.status} ${response.statusText}`.trim(),
        );
        return undefined;
      }
      return parseProfileFeaturesLimited(await response.json(), appId);
    } catch (error) {
      console.error(`[Steam 探索队列] 查询或解析 App ${appId} 的个人资料功能时出错`, error);
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
