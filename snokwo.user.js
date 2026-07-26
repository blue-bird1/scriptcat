// ==UserScript==
// @name         Sonkwo Steam AppID提取器
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  从Sonkwo商店搜索页面提取游戏的Steam AppID并保存
// @author       豆包编程助手
// @match        https://www.sonkwo.hk/store/search*
// @match        https://steampy.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @require      https://scriptcat.org/lib/637/1.4.8/ajaxHooker.js#sha256=dTF50feumqJW36kBpbf6+LguSLAtLr7CEs3oPmyfbiM=
// @connect      www.sonkwo.hk
// @connect      steampy.com
// ==/UserScript==

/* global ajaxHooker */

(() => {
  // src/lib/steampy/access-token.js
  var GM_ACCESS_TOKEN_KEY = "accessToken";
  var LOCAL_ACCESS_TOKEN_KEY = "accessToken";
  function readSteampyLocalToken() {
    return window.localStorage.getItem(LOCAL_ACCESS_TOKEN_KEY) || "";
  }
  function syncSteampyTokenToGmStorage(options = {}) {
    const token = readSteampyLocalToken();
    if (!token) {
      return false;
    }
    GM_setValue(GM_ACCESS_TOKEN_KEY, token);
    if (options.log !== false) {
      const prefix = options.logPrefix || "[SteamPy]";
      console.log(`${prefix} 已同步 accessToken 到 GM 存储`);
    }
    return true;
  }
  function syncSteampyTokenOnSteampyPage(options = {}) {
    if (!location.hostname.includes("steampy.com")) {
      return false;
    }
    return syncSteampyTokenToGmStorage(options);
  }

  // src/lib/userscript/gm-xhr.js
  function gmXhr(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        timeout: 2e4,
        ...options,
        onload: resolve,
        onerror: () => reject(new Error("网络请求失败")),
        ontimeout: () => reject(new Error("网络请求超时"))
      });
    });
  }

  // src/lib/steampy/xboot-client.js
  var STEAMPY_ORIGIN = "https://steampy.com";
  var NEED_LOGIN_PATH = "/xboot/common/needLogin";
  var STEAMPY_XBOOT_LOG_PREFIX = "[SteamPy Plus][XBoot]";
  var KEY_SALE_ENDPOINTS = {
    cn: {
      game: "/xboot/steamGame",
      keySale: "/xboot/steamKeySale"
    },
    ru: {
      game: "/xboot/ruSteamGame",
      keySale: "/xboot/ruKeySale"
    },
    us: {
      game: "/xboot/usSteamGame",
      keySale: "/xboot/usKeySale"
    },
    tl: {
      game: "/xboot/tlSteamGame",
      keySale: "/xboot/tlKeySale"
    }
  };
  function buildSteampyXbootHeaders(accessToken, referer = `${STEAMPY_ORIGIN}/pro/seller/sellerCDKey`) {
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
      referrer: referer
    };
  }
  function buildStartKeySalePayload({
    gameId,
    keys,
    sellPrice,
    keyWord = "",
    syncUs = "0",
    osflag
  }) {
    const data = {
      gameId: String(gameId),
      keys: String(keys),
      keyWord: String(keyWord ?? ""),
      sellPrice: String(sellPrice),
      syncUs: String(syncUs ?? "0")
    };
    if (osflag !== void 0) {
      data.osflag = osflag;
    }
    return data;
  }
  function encodeSteampyFormPayload(data) {
    return Object.keys(data).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(data[key]))}`).join("&");
  }
  function createSteampyXbootClient(options = {}) {
    const getAccessToken = options.getAccessToken || (() => "");
    const logger = options.logger || console;
    const sendRequest = options.sendRequest || gmXhr;
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
      const request = {
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
          ...xhrOverrides.headers
        }
      };
      const logRequest = requestOptions.logRequest === true;
      if (logRequest) {
        logger.log(`${STEAMPY_XBOOT_LOG_PREFIX} request`, request);
      }
      let response;
      try {
        response = await sendRequest(request);
      } catch (error) {
        if (logRequest) {
          logger.error(`${STEAMPY_XBOOT_LOG_PREFIX} transport error`, { request, error });
        }
        throw error;
      }
      if (logRequest) {
        logger.log(`${STEAMPY_XBOOT_LOG_PREFIX} response`, { request, response });
      }
      const finalPathname = response.finalUrl ? new URL(response.finalUrl, STEAMPY_ORIGIN).pathname : "";
      const redirectedToNeedLogin = response.status === 302 && finalPathname === NEED_LOGIN_PATH;
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
        gameName: ""
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
        gameName
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
        gameId
      }));
    }
    async function startKeySale({
      region = "cn",
      gameId,
      keys,
      sellPrice,
      keyWord = "",
      syncUs = "0",
      osflag
    }) {
      const endpoints = getKeySaleEndpoints(region);
      const data = buildStartKeySalePayload({
        gameId,
        keys,
        keyWord,
        sellPrice,
        syncUs,
        osflag
      });
      return requestJson(`${STEAMPY_ORIGIN}${endpoints.keySale}/startSell`, {
        method: "POST",
        data: encodeSteampyFormPayload(data),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        logRequest: true
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
      requestJson
    };
  }

  // src/lib/sonkwo/search-price.js
  function startSnokwoSearchPrice() {
    if (location.hostname.includes("steampy.com")) {
      syncSteampyTokenOnSteampyPage({ logPrefix: "[SteamPY价格脚本]" });
      return;
    }
    ajaxHooker.hook((request) => {
      if (request.url.startsWith("https://www.sonkwo.cn/api/search/skus.json")) {
        request.response = (res) => {
          try {
            const data = JSON.parse(res.responseText);
            processGameData(data);
          } catch (e) {
            console.error("解析steampy API(XHR)数据失败：", e);
          }
        };
      }
      return request;
    });
    const gameData = {};
    function processGameData(data) {
      const skus = data.skus;
      for (const sku of skus) {
        const appid = sku.id;
        if (appid) {
          gameData[appid] = sku;
        }
      }
    }
    const steampyClient = createSteampyXbootClient({
      getAccessToken: () => GM_getValue("accessToken", ""),
      onTokenInvalid: () => {
        alert("提示：accesstoken可能已过期，请在脚本 CONFIG 区更新有效token！");
      }
    });
    function showError(message) {
      console.error(message);
    }
    async function fetchGamePrice(gameName) {
      try {
        console.log(`request saleKeyByName for ${gameName}`);
        const { result } = await steampyClient.fetchSaleKeyByName(gameName);
        return result;
      } catch (error) {
        showError(error);
        showError(`网络请求错误：${error.message || "无法连接到SteamPy服务器"}`);
      }
    }
    const processedItems = /* @__PURE__ */ new Set();
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === "childList") {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === 1 && node.classList.contains("sku-list-item")) {
              if (!processedItems.has(node)) {
                processSkuItem(node);
                processedItems.add(node);
              }
            }
            if (node.nodeType === 1) {
              const skuItems = node.getElementsByClassName("sku-list-item");
              Array.from(skuItems).forEach((item) => {
                if (!processedItems.has(item)) {
                  processSkuItem(item);
                  processedItems.add(item);
                }
              });
            }
          });
        }
        if (mutation.type === "characterData" && mutation.target.parentNode) {
          const skuItem = mutation.target.parentNode.closest(".sku-list-item");
          if (skuItem && processedItems.has(skuItem)) {
            console.debug("处理文本内容变化", skuItem);
            processSkuItem(skuItem);
          }
        }
        if (mutation.type === "attributes") {
          const skuItem = mutation.target.closest(".sku-list-item");
          if (skuItem && processedItems.has(skuItem)) {
            console.debug("处理属性变化", skuItem);
            processSkuItem(skuItem);
          }
        }
      });
    });
    window.addEventListener("load", () => {
      console.log("加载完成 加载观察者");
      observer.observe(document.querySelector("#background_inner > div > div > div.search-left"), {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
    });
    const processedSkusDict = GM_getValue("processedSkus", {});
    async function getGameData(skuId, title) {
      if (processedSkusDict[skuId] !== void 0) {
        console.debug(`重复处理，跳过${skuId} ${title}`);
        return processedSkusDict[skuId];
      }
      console.debug(`处理SKUid：${skuId} SKU标题：${title}`);
      const data = await fetchGamePrice(title);
      if (data) {
        if (data.content && data.content.length > 0) {
          const matchedGameData = data.content.find((game) => game.gameName === title);
          processedSkusDict[skuId] = matchedGameData || data.content[0];
          GM_setValue("processedSkus", processedSkusDict);
          return matchedGameData || data.content[0] || null;
        }
        processedSkusDict[skuId] = null;
        GM_setValue("processedSkus", processedSkusDict);
      } else {
        console.log(`获取数据失败 skuid:${skuId}  title:${title}`);
        processedSkusDict[skuId] = null;
        GM_setValue("processedSkus", processedSkusDict);
      }
    }
    async function processSkuItem(item) {
      const linkElement = item.querySelector("a.listed-game-block");
      if (!linkElement) {
        return;
      }
      const skuUrl = linkElement.getAttribute("href");
      const skuId = skuUrl.split("/").pop();
      const skuIdInt = parseInt(skuId, 10);
      const curGameData = gameData[skuIdInt];
      const titleEn = curGameData?.sku_names.en;
      try {
        const data = await getGameData(skuId, titleEn);
        if (data && data.keyPrice !== void 0) {
          addPriceInfoToItem(item, data, curGameData);
        } else {
          console.log(`未找到${titleEn}的价格数据`);
        }
      } catch (error) {
        console.error(`处理${titleEn}时出错:`, error);
      }
    }
    function addPriceInfoToItem(item, data, curGameData) {
      const priceContainer = item.querySelector(".content-info-b");
      if (!priceContainer) {
        return;
      }
      const existingPriceInfo = priceContainer.querySelector(".steampy-info");
      if (existingPriceInfo) {
        return;
      }
      const steamPyInfo = document.createElement("div");
      steamPyInfo.className = "steampy-info";
      const titleEn = curGameData?.sku_names.en;
      let titlecheck = false;
      if (data && data.gameName !== titleEn && data.gameName !== curGameData?.sku_names.default) {
        console.log(`游戏名称不匹配：${data.gameName} != ${titleEn}`);
        titlecheck = true;
      }
      let formattedPrice;
      if (data.keyPrice === null) {
        formattedPrice = "N/A";
      } else {
        formattedPrice = data.keyPrice.toFixed(2);
      }
      steamPyInfo.innerHTML = `
        <div style="">
            <div style="color: #e53935; font-weight: 500;">
                SteamPy价格: ￥${formattedPrice}
            </div>
            <div style="color: #666;">
                销售者: ${data.keySales || 0}
            </div>
              <div style="color: #666;">
            交易量: ${data.keyTx || 0}
            </div>
        </div>
          ${titlecheck ? '<span style="color: #e53935;font-weight: 500;">名称不匹配 可能有误</span>' : ""}

    `;
      const buyNowButton = item.querySelector(".buy-now");
      if (buyNowButton && buyNowButton.parentNode) {
        buyNowButton.parentNode.insertBefore(steamPyInfo, buyNowButton);
      } else {
        priceContainer.appendChild(steamPyInfo);
      }
      console.log(`已为${data.gameNameCn || data.gameName}添加价格信息`);
    }
    function showSavedAppIds() {
      console.log("已保存的Steam AppID列表:", processedSkusDict);
    }
    function clearErrorFetchCache() {
      for (const skuId in processedSkusDict) {
        if (processedSkusDict[skuId] === null) {
          delete processedSkusDict[skuId];
        }
      }
      GM_setValue("processedSkus", processedSkusDict);
    }
    console.log("Sonkwo Steam AppID提取器已启动");
    GM_registerMenuCommand("查看已保存的Steam AppID", showSavedAppIds);
    GM_registerMenuCommand("清除错误缓存", clearErrorFetchCache);
  }

  // src/userscripts/snokwo.user.js
  startSnokwoSearchPrice();
})();
