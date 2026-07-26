import { gmXhr } from "../userscript/gm-xhr.js";

const STEAMPY_ORIGIN = "https://steampy.com";
const NEED_LOGIN_PATH = "/xboot/common/needLogin";
const KEY_SALE_ENDPOINTS = {
  cn: {
    game: "/xboot/steamGame",
    keySale: "/xboot/steamKeySale",
  },
  ru: {
    game: "/xboot/ruSteamGame",
    keySale: "/xboot/ruKeySale",
  },
  us: {
    game: "/xboot/usSteamGame",
    keySale: "/xboot/usKeySale",
  },
  tl: {
    game: "/xboot/tlSteamGame",
    keySale: "/xboot/tlKeySale",
  },
};

export function buildSteampyXbootHeaders(accessToken, referer = `${STEAMPY_ORIGIN}/pro/seller/sellerCDKey`) {
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    accesstoken: accessToken || "",
    app_token: "",
    "sec-ch-ua": '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-gpc": "1",
    referrer: referer,
  };
}

export function createSteampyXbootClient(options = {}) {
  const getAccessToken = options.getAccessToken || (() => "");
  let tokenInvalid = false;

  function markTokenInvalid(reason) {
    tokenInvalid = true;
    if (typeof options.onTokenInvalid === "function") {
      options.onTokenInvalid(reason);
    }
  }

  function isTokenInvalid() {
    return tokenInvalid;
  }

  async function requestJson(url, requestOptions = {}) {
    if (tokenInvalid) {
      throw new Error("AccessToken 已失效，已停止后续请求。请重新登录 steampy.com 后刷新页面。");
    }

    const xhrOverrides = requestOptions.xhrOverrides || {};
    const response = await gmXhr({
      method: requestOptions.method || "GET",
      url: url.toString(),
      withCredentials: true,
      anonymous: false,
      responseType: requestOptions.responseType || "json",
      data: requestOptions.data,
      ...xhrOverrides,
      headers: {
        ...buildSteampyXbootHeaders(getAccessToken(), requestOptions.referer),
        ...requestOptions.headers,
        ...xhrOverrides.headers,
      },
    });

    const finalPathname = response.finalUrl
      ? new URL(response.finalUrl, STEAMPY_ORIGIN).pathname
      : "";
    const redirectedToNeedLogin =
      response.status === 302 && finalPathname === NEED_LOGIN_PATH;

    if (redirectedToNeedLogin) {
      markTokenInvalid("AccessToken 已过期（接口返回 302 跳转至 /xboot/common/needLogin）");
      throw new Error("AccessToken 已过期（接口返回 302 跳转至 /xboot/common/needLogin）");
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP请求失败，状态码：${response.status}`);
    }

    const resultData = response.response;
    if (!resultData || !resultData.success || resultData.code !== 200) {
      const errMsg = `业务请求失败：${resultData?.message || "未知错误"}`;
      if (resultData?.message?.includes("token") || resultData?.code === 401) {
        markTokenInvalid(errMsg);
      }
      throw new Error(errMsg);
    }

    return resultData.result;
  }

  function buildSearchUrl(path, params) {
    const requestUrl = new URL(`${STEAMPY_ORIGIN}${path}`);
    Object.entries(params).forEach(([key, value]) => {
      requestUrl.searchParams.set(key, String(value));
    });
    return requestUrl;
  }

  function getKeySaleEndpoints(region) {
    if (!Object.hasOwn(KEY_SALE_ENDPOINTS, region)) {
      throw new Error(`不支持的上架地区：${region}`);
    }
    return KEY_SALE_ENDPOINTS[region];
  }

  async function fetchSaleKeyByUrl(gameUrl, region = "cn") {
    const endpoints = getKeySaleEndpoints(region);
    const requestUrl = buildSearchUrl(`${endpoints.game}/saleKeyByUrl`, {
      pageNumber: 1,
      pageSize: 10,
      sort: "id",
      order: "asc",
      gameUrl,
      gameName: "",
    });
    const result = await requestJson(requestUrl);
    return { success: true, result };
  }

  async function fetchSaleKeyByName(gameName, region = "cn") {
    const endpoints = getKeySaleEndpoints(region);
    const requestUrl = buildSearchUrl(`${endpoints.game}/saleKeyByName`, {
      pageNumber: 1,
      pageSize: 10,
      sort: "id",
      order: "asc",
      gameUrl: "",
      gameName,
    });
    const result = await requestJson(requestUrl);
    return { success: true, result };
  }

  async function fetchFilterMetadata() {
    return requestJson(buildSearchUrl("/xboot/pyFilter/list", {}));
  }

  async function fetchSteamAppList(params) {
    return requestJson(buildSearchUrl("/xboot/steamApp/list", params));
  }

  async function fetchSteamGameByAppId(appId) {
    return requestJson(buildSearchUrl("/xboot/steamGame/searchByAppId", { appId }));
  }

  async function fetchKeySaleList({ region = "cn", gameId }) {
    const endpoints = getKeySaleEndpoints(region);
    return requestJson(buildSearchUrl(`${endpoints.keySale}/listSale`, {
      pageNumber: 1,
      pageSize: 20,
      sort: "keyPrice",
      order: "asc",
      startDate: "",
      endDate: "",
      gameId,
    }));
  }

  async function startKeySale({
    region = "cn",
    gameId,
    keys,
    sellPrice,
    keyWord,
    syncUs,
    osflag,
  }) {
    const endpoints = getKeySaleEndpoints(region);

    const data = { gameId, keys, sellPrice };
    if (keyWord !== undefined) {
      data.keyWord = keyWord;
    }
    if (syncUs !== undefined) {
      data.syncUs = syncUs;
    }
    if (osflag !== undefined) {
      data.osflag = osflag;
    }

    return requestJson(`${STEAMPY_ORIGIN}${endpoints.keySale}/startSell`, {
      method: "POST",
      data: JSON.stringify(data),
      headers: { "Content-Type": "application/json" },
    });
  }

  return {
    fetchFilterMetadata,
    isTokenInvalid,
    fetchSaleKeyByUrl,
    fetchSaleKeyByName,
    fetchKeySaleList,
    fetchSteamAppList,
    fetchSteamGameByAppId,
    startKeySale,
    requestJson,
  };
}
