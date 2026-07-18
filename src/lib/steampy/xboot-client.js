import { gmXhr } from "../userscript/gm-xhr.js";

const STEAMPY_ORIGIN = "https://steampy.com";
const NEED_LOGIN_PATH = "/xboot/common/needLogin";

export function buildSteampyXbootHeaders(accessToken, referer = `${STEAMPY_ORIGIN}/pyUserInfo/sellerCDKey`) {
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

    const response = await gmXhr({
      method: "GET",
      url: url.toString(),
      headers: buildSteampyXbootHeaders(getAccessToken(), requestOptions.referer),
      withCredentials: true,
      anonymous: false,
      responseType: requestOptions.responseType || "json",
      ...requestOptions.xhrOverrides,
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

  async function fetchSaleKeyByUrl(gameUrl) {
    const requestUrl = buildSearchUrl("/xboot/steamGame/saleKeyByUrl", {
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

  async function fetchSaleKeyByName(gameName) {
    const requestUrl = buildSearchUrl("/xboot/steamGame/saleKeyByName", {
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

  return {
    fetchFilterMetadata,
    isTokenInvalid,
    fetchSaleKeyByUrl,
    fetchSaleKeyByName,
    fetchSteamAppList,
    fetchSteamGameByAppId,
    requestJson,
  };
}
