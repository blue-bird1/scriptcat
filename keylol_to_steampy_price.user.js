// ==UserScript==
// @name         KeyLol SteamPY 价格及总价显示
// @version      1.8
// @description  在Keylol帖子显示Steam游戏的SteamPY CDKey价格，并计算每个引用块内的总价
// @author       bluebird
// @match        https://keylol.com/t*
// @match        https://keylol.com/forum.php?mod=viewthread*
// @match        https://steampy.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      steampy.com
// @connect      keylol.com
// @connect      store.steampowered.com
// @run-at       document-end
// @icon         https://steampy.com/m_logo.ico
// @license      MIT
// @namespace    https://greasyfork.org/users/
// ==/UserScript==

(() => {
  // src/lib/steampy/access-token.js
  var GM_ACCESS_TOKEN_KEY = "accessToken";
  var LOCAL_ACCESS_TOKEN_KEY = "accessToken";
  function readSteampyLocalToken() {
    return window.localStorage.getItem(LOCAL_ACCESS_TOKEN_KEY) || "";
  }
  function readSteampyGmToken(defaultValue = null) {
    return GM_getValue(GM_ACCESS_TOKEN_KEY, defaultValue);
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
  function buildSteampyXbootHeaders(accessToken, referer = `${STEAMPY_ORIGIN}/pyUserInfo/sellerCDKey`) {
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
  function createSteampyXbootClient(options = {}) {
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
        ...requestOptions.xhrOverrides
      });
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
    async function fetchSaleKeyByUrl(gameUrl) {
      const requestUrl = buildSearchUrl("/xboot/steamGame/saleKeyByUrl", {
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
    async function fetchSaleKeyByName(gameName) {
      const requestUrl = buildSearchUrl("/xboot/steamGame/saleKeyByName", {
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
    return {
      fetchFilterMetadata,
      isTokenInvalid,
      fetchSaleKeyByUrl,
      fetchSaleKeyByName,
      fetchSteamAppList,
      fetchSteamGameByAppId,
      requestJson
    };
  }

  // src/lib/keylol/steampy-price.js
  function startKeylolSteampyPrice() {
    "use strict";
    const BASE_CONFIG = {
      STEAMPY_BASE_URL: "https://steampy.com/",
      STEAM_STORE_URL: "https://store.steampowered.com",
      STEAM_APP_URL_REG: /https:\/\/store\.steampowered\.com\/app\/(\d+)\/?/i,
      TARGET_CONTAINERS: [
        '#postlist > [id^="post_"]:first-of-type .quote blockquote'
      ],
      CACHE: {
        KEY_PREFIX: "steampy_key_price_cache_",
        EXPIRY_HOURS: 24,
        MAX_ITEMS: 100
      }
    };
    const API_ENDPOINTS = {
      getGamePrice: (subId, appId, type) => `${BASE_CONFIG.STEAMPY_BASE_URL}xboot/common/plugIn/getGame?subId=${subId}&appId=${appId}&type=${type}`,
      getCdkDetailUrl: (gameId) => `${BASE_CONFIG.STEAMPY_BASE_URL}cdkDetail?name=cn&gameId=${gameId}`,
      searchGameByUrl: "https://steampy.com/xboot/steamGame/saleKeyByUrl"
    };
    GM_registerMenuCommand(
      "清除 SteamPY Key 价格缓存",
      function clearSteamPyPriceCache() {
        try {
          CacheUtils.deleteMainCache();
          alert("✅ SteamPY Key 价格缓存已清除!");
        } catch (error) {
          console.error("[清除缓存失败]", error);
          alert(`❌ 清除失败：${error.message}`);
        }
      }
    );
    const quotePrices = /* @__PURE__ */ new Map();
    const addedPriceAppIds = /* @__PURE__ */ new Set();
    let isAccessTokenInvalid = false;
    let tokenInvalidNoticeShown = false;
    const CacheUtils = {
      // 唯一总缓存Key（所有AppID数据都存在这里）
      MAIN_CACHE_KEY: "keyLol_steamPy_allGameCache",
      /**
       * 获取总缓存数据（统一管理所有AppID的缓存）
       * @returns {object} 格式：{ appId: { data: 价格数据, timestamp: 时间戳 }, ... }
       */
      getMainCache: () => {
        try {
          const rawData = GM_getValue(CacheUtils.MAIN_CACHE_KEY, "{}");
          const parsedData = JSON.parse(rawData);
          return typeof parsedData === "object" && parsedData !== null ? parsedData : {};
        } catch (err) {
          console.warn("读取总缓存失败，重置为空对象：", err);
          GM_setValue(CacheUtils.MAIN_CACHE_KEY, "{}");
          return {};
        }
      },
      deleteMainCache: () => {
        try {
          GM_deleteValue(CacheUtils.MAIN_CACHE_KEY);
        } catch (err) {
          console.error("删除总缓存失败：", err);
          throw err;
        }
      },
      /**
       * 保存总缓存数据
       * @param {object} cacheData 要保存的总缓存对象
       */
      saveMainCache: (cacheData) => {
        try {
          GM_setValue(CacheUtils.MAIN_CACHE_KEY, JSON.stringify(cacheData));
        } catch (err) {
          console.error("保存总缓存失败：", err);
        }
      },
      /**
       * 生成AppID对应的缓存标识（仅内部兼容用，无实际独立Key）
       * @param {string} appId Steam应用ID
       * @returns {string} AppID（直接返回，无前缀）
       */
      getCacheKey: (appId) => appId,
      /**
       * 获取所有缓存的AppID列表
       * @returns {string[]} AppID数组
       */
      getAllCacheKeys: () => {
        const mainCache = CacheUtils.getMainCache();
        return Object.keys(mainCache);
      },
      /**
       * 检查指定AppID的缓存是否有效
       * @param {string} appId Steam应用ID
       * @returns {boolean} 缓存是否有效
       */
      isCacheValid: (appId) => {
        const mainCache = CacheUtils.getMainCache();
        const cacheItem = mainCache[appId];
        if (!cacheItem || !cacheItem.timestamp || !cacheItem.data) return false;
        try {
          const now = Date.now();
          const expiryMs = BASE_CONFIG.CACHE.EXPIRY_HOURS * 60 * 60 * 1e3;
          return now - cacheItem.timestamp <= expiryMs;
        } catch (err) {
          console.warn(`缓存校验失败（AppID: ${appId}）：`, err);
          CacheUtils.deleteCache(appId);
          return false;
        }
      },
      /**
       * 获取指定AppID的缓存数据
       * @param {string} appId Steam应用ID
       * @returns {object|null} 缓存的价格数据，无效则返回null
       */
      getCache: (appId) => {
        if (!CacheUtils.isCacheValid(appId)) return null;
        const mainCache = CacheUtils.getMainCache();
        return mainCache[appId]?.data || null;
      },
      /**
       * 设置指定AppID的缓存数据
       * @param {string} appId Steam应用ID
       * @param {object} priceData 价格数据
       */
      setCache: (appId, priceData) => {
        if (!priceData || !priceData.success || !priceData.result) return;
        try {
          const mainCache = CacheUtils.getMainCache();
          mainCache[appId] = {
            data: priceData,
            timestamp: Date.now()
          };
          CacheUtils.cleanExpiredCache();
          CacheUtils.limitCacheSize();
          CacheUtils.saveMainCache(mainCache);
        } catch (err) {
          console.error(`缓存存储失败（AppID: ${appId}）：`, err);
        }
      },
      /**
       * 删除指定AppID的缓存
       * @param {string} appId Steam应用ID
       */
      deleteCache: (appId) => {
        const mainCache = CacheUtils.getMainCache();
        delete mainCache[appId];
        CacheUtils.saveMainCache(mainCache);
      },
      /**
       * 清理所有过期的缓存项
       */
      cleanExpiredCache: () => {
        const now = Date.now();
        const expiryMs = BASE_CONFIG.CACHE.EXPIRY_HOURS * 60 * 60 * 1e3;
        let deletedCount = 0;
        const mainCache = CacheUtils.getMainCache();
        Object.keys(mainCache).forEach((appId) => {
          const cacheItem = mainCache[appId];
          if (!cacheItem || !cacheItem.timestamp) {
            delete mainCache[appId];
            deletedCount++;
            return;
          }
          try {
            if (now - cacheItem.timestamp > expiryMs) {
              delete mainCache[appId];
              deletedCount++;
            }
          } catch {
            delete mainCache[appId];
            deletedCount++;
          }
        });
        CacheUtils.saveMainCache(mainCache);
        if (deletedCount > 0) {
          console.log(`清理过期缓存：共删除 ${deletedCount} 条`);
        }
      },
      /**
       * 限制缓存总数量（超出则删除最旧的）
       */
      limitCacheSize: () => {
        const mainCache = CacheUtils.getMainCache();
        const cacheList = Object.keys(mainCache).map((appId) => ({
          appId,
          timestamp: mainCache[appId].timestamp || 0
        }));
        if (cacheList.length <= BASE_CONFIG.CACHE.MAX_ITEMS) return;
        cacheList.sort((a, b) => a.timestamp - b.timestamp);
        const needDeleteCount = cacheList.length - BASE_CONFIG.CACHE.MAX_ITEMS;
        for (let i = 0; i < needDeleteCount; i++) {
          delete mainCache[cacheList[i].appId];
        }
        CacheUtils.saveMainCache(mainCache);
        console.log(`缓存数量超限，删除最旧的 ${needDeleteCount} 条缓存`);
      }
    };
    function getAccessToken() {
      return readSteampyGmToken(null);
    }
    function showTopNotice(message, once = true) {
      if (!document.body) return;
      if (once && tokenInvalidNoticeShown) return;
      if (once) tokenInvalidNoticeShown = true;
      const notice = document.createElement("div");
      notice.style.cssText = "background:#fff3cd;border:1px solid #ffeeba;color:#856404;padding:8px;margin:8px;font-size:13px;";
      notice.textContent = message;
      document.body.insertBefore(notice, document.body.firstChild);
    }
    const xbootClient = createSteampyXbootClient({
      getAccessToken: () => readSteampyGmToken(null) || "",
      onTokenInvalid: () => {
        isAccessTokenInvalid = true;
        showTopNotice(
          "提示：SteamPY AccessToken 可能已过期。请前往 steampy.com 重新登录后刷新页面。"
        );
      }
    });
    const findParentQuote = (element) => {
      return element.closest(".quote") || null;
    };
    const extractAppIdFromUrl = (url) => {
      const match = url.match(BASE_CONFIG.STEAM_APP_URL_REG);
      return match && match[1] ? match[1] : null;
    };
    const updateQuoteTotal = (quoteElement) => {
      if (!quoteElement) return;
      const priceObjects = quotePrices.get(quoteElement) || [];
      const validPrices = priceObjects.map((priceObj) => priceObj.price).filter((price) => typeof price === "number" && !isNaN(price) && price > 0);
      const total = validPrices.reduce((sum, price) => sum + price, 0);
      const originalCount = priceObjects.length;
      let totalElement = quoteElement.querySelector(".steampy-quote-total");
      if (!totalElement) {
        totalElement = document.createElement("div");
        totalElement.className = "steampy-quote-total";
        quoteElement.appendChild(totalElement);
      }
      totalElement.innerHTML = `
            <hr style="margin: 8px 0; border: none; border-top: 1px dashed #ccc;">
            <div class="total-text">
                SteamPY Key 总价: <strong>￥${total.toFixed(2)}</strong>
                <span class="total-count">(${validPrices.length}/${originalCount} 个有效价格)</span>
            </div>
        `;
    };
    const getAllSteamLinks = () => {
      const linkSet = /* @__PURE__ */ new Set();
      const targetContainers = BASE_CONFIG.TARGET_CONTAINERS.flatMap(
        (selector) => Array.from(document.querySelectorAll(selector))
      );
      targetContainers.forEach((container) => {
        const allSteamLinks = container.querySelectorAll(
          'a[href*="store.steampowered.com/app/"]:not(.showhide a, .showhide *, .sff_collapse a, .sff_collapse *)'
        );
        allSteamLinks.forEach((link) => {
          const url = new URL(link.href);
          url.search = "";
          link.href = url.toString();
        });
        console.log(allSteamLinks);
        allSteamLinks.forEach((link) => {
          const href = link.href;
          const appId = extractAppIdFromUrl(href);
          const isValid = appId && !href.includes("store.steampowered.com/sub/") && ((link.previousElementSibling?.href ?? link.parentElement.previousElementSibling?.href)?.includes("barter.vg") || (link.previousElementSibling?.href ?? link.parentElement.previousElementSibling?.href)?.includes("104.236.232.190") || link.previousElementSibling?.textContent?.includes("无进包记录"));
          if (isValid) {
            link.dataset.appId = appId;
            linkSet.add(link);
          }
        });
      });
      return Array.from(linkSet);
    };
    const createPricePlaceholder = () => {
      const placeholder = document.createElement("span");
      placeholder.className = "steampy-key-price-placeholder";
      placeholder.innerHTML = ' | <span class="steampy-loading">SteamPY Key价加载中...</span>';
      return placeholder;
    };
    const updatePriceDisplay = (placeholder, priceData, errorMsg = "SteamPY Key价加载失败", linkElement, includeInQuote = true) => {
      placeholder.className = "steampy-key-price-container";
      const quoteElement = findParentQuote(linkElement);
      if (includeInQuote && quoteElement && quotePrices.has(quoteElement)) {
        const prices = quotePrices.get(quoteElement);
        const newPrices = prices.filter((p) => p.link !== linkElement);
        quotePrices.set(quoteElement, newPrices);
      }
      if (!priceData || !priceData.success || !priceData.result || !priceData.result.content || priceData.result.content.length === 0) {
        placeholder.innerHTML = ` | <span class="steampy-error">${errorMsg}</span>`;
        if (includeInQuote && quoteElement) {
          const prices = quotePrices.get(quoteElement) || [];
          prices.push({ link: linkElement, price: 0 });
          quotePrices.set(quoteElement, prices);
          updateQuoteTotal(quoteElement);
        }
        return;
      }
      const { keyPrice, keyTx, keySales, id: gameId } = priceData.result.content[0];
      const formattedPrice = keyPrice && keyPrice > 0 ? `￥${keyPrice.toFixed(2)}` : "￥--";
      const numericPrice = keyPrice && keyPrice > 0 ? parseFloat(keyPrice) : 0;
      const formattedTx = keyTx && keyTx > 0 ? `销量${keyTx} 件` : "-- 项";
      const formattedSales = keySales && keySales > 0 ? `销售人数${keySales} 人` : "-- 人";
      placeholder.innerHTML = ` | 
            <a 
                href="${API_ENDPOINTS.getCdkDetailUrl(gameId)}" 
                target="_blank" 
                class="steampy-key-price-link" 
                title="前往 SteamPY 查看 CDKey 详情"
            >
                SteamPY Key: ${formattedPrice} | ${formattedTx} | ${formattedSales}
            </a>
        `;
      if (includeInQuote && quoteElement) {
        const prices = quotePrices.get(quoteElement) || [];
        prices.push({ link: linkElement, price: numericPrice });
        quotePrices.set(quoteElement, prices);
        updateQuoteTotal(quoteElement);
      }
    };
    async function fetchGamePrice(gameUrl) {
      if (isAccessTokenInvalid) {
        throw new Error(
          "AccessToken 已失效，已停止后续请求。请重新登录 steampy.com 后刷新页面。"
        );
      }
      try {
        console.log(`[SteamPY价格脚本] 请求价格数据：${gameUrl}`);
        return await xbootClient.fetchSaleKeyByUrl(gameUrl);
      } catch (error) {
        console.error(`[SteamPY价格脚本] ${error.message}`);
        return {
          success: false,
          message: error.message
        };
      }
    }
    const getPriceWithCacheAndSubId = async (appId, placeholder, linkElement, includeInQuote = true) => {
      try {
        const cachedData = CacheUtils.getCache(appId);
        let priceData = null;
        if (cachedData) {
          console.log(`[SteamPY价格脚本] 使用缓存数据（AppID: ${appId}）`);
          priceData = cachedData;
        } else {
          updatePriceDisplay(placeholder, null, "获取价格中...", linkElement, includeInQuote);
          console.log(`[SteamPY价格脚本] 获取价格（AppID: ${appId}）`);
          priceData = await fetchGamePrice(linkElement.href);
          if (priceData.success) {
            CacheUtils.setCache(appId, priceData);
          }
        }
        updatePriceDisplay(placeholder, priceData, "", linkElement, includeInQuote);
      } catch (err) {
        console.error(`[SteamPY价格脚本] 价格获取失败（AppID: ${appId}）：`, err);
        updatePriceDisplay(
          placeholder,
          null,
          `获取价格失败: ${err.message}`,
          linkElement,
          includeInQuote
        );
      }
    };
    const linkHasSteampyPriceSibling = (link) => {
      let sibling = link.nextElementSibling;
      while (sibling) {
        if (sibling.classList.contains("steampy-key-price-container") || sibling.classList.contains("steampy-key-price-placeholder")) {
          return true;
        }
        sibling = sibling.nextElementSibling;
      }
      return false;
    };
    const addPriceToSteamLink = (link) => {
      const appId = link.dataset.appId;
      if (!appId) return;
      const appIdStr = String(appId);
      if (addedPriceAppIds.has(appIdStr)) return;
      if (linkHasSteampyPriceSibling(link)) return;
      addedPriceAppIds.add(appIdStr);
      const placeholder = createPricePlaceholder();
      try {
        link.parentNode.insertBefore(placeholder, link.nextSibling);
      } catch {
        addedPriceAppIds.delete(appIdStr);
        return;
      }
      getPriceWithCacheAndSubId(appIdStr, placeholder, link);
    };
    const injectStyles = () => {
      const style = document.createElement("style");
      style.textContent = `
            .steampy-key-price-container,
            .steampy-key-price-placeholder {
                margin-left: 4px;
                font-size: 13px;
                color: #666;
                line-height: 1.5;
            }
            .steampy-key-price-link {
                color: #2E86AB;
                text-decoration: none;
                padding: 0 2px;
            }
            .steampy-key-price-link:hover {
                color: #A23B72;
                text-decoration: underline;
            }
            .steampy-loading {
                color: #888;
                font-style: italic;
            }
            .steampy-error {
                color: #E74C3C;
            }
            .quote .steampy-key-price-container,
            .quote .steampy-key-price-placeholder {
                font-size: 12px;
            }
            .steampy-quote-total {
                margin-top: 10px;
                padding-top: 5px;
                font-size: 14px;
            }
            .total-text {
                color: #333;
                font-weight: bold;
            }
            .total-count {
                font-size: 12px;
                color: #666;
                font-weight: normal;
                margin-left: 8px;
            }
        `;
      document.head.appendChild(style);
    };
    const initQuoteTotals = () => {
      const quotes = document.querySelectorAll(".quote");
      quotes.forEach((quote) => {
        if (!quotePrices.has(quote)) {
          quotePrices.set(quote, []);
        }
      });
    };
    const addHoverFetchForSteamLinks = () => {
      document.addEventListener(
        "mouseover",
        (event) => {
          const target = event.target;
          if (!target) return;
          const link = target.closest && target.closest('a[href*="store.steampowered.com/app/"]') || null;
          if (!link) return;
          if (event.relatedTarget && link.contains(event.relatedTarget)) {
            return;
          }
          const appId = link.dataset.appId || extractAppIdFromUrl(link.href);
          if (!appId) return;
          link.dataset.appId = appId;
          const appIdStr = String(appId);
          if (addedPriceAppIds.has(appIdStr)) return;
          if (linkHasSteampyPriceSibling(link)) return;
          addedPriceAppIds.add(appIdStr);
          const placeholder = createPricePlaceholder();
          if (linkHasSteampyPriceSibling(link)) {
            addedPriceAppIds.delete(appIdStr);
            return;
          }
          try {
            link.parentNode.insertBefore(placeholder, link.nextSibling);
          } catch {
            addedPriceAppIds.delete(appIdStr);
            return;
          }
          getPriceWithCacheAndSubId(appIdStr, placeholder, link, false);
        },
        { capture: true }
      );
    };
    const init = () => {
      CacheUtils.cleanExpiredCache();
      injectStyles();
      initQuoteTotals();
      addHoverFetchForSteamLinks();
      const steamLinks = getAllSteamLinks();
      if (steamLinks.length === 0) {
        console.log("[SteamPY价格脚本] 当前页面未找到 Steam 游戏链接");
        return;
      }
      console.log(`[SteamPY价格脚本] 找到 ${steamLinks.length} 个 Steam 游戏链接，开始加载价格...`);
      steamLinks.forEach(addPriceToSteamLink);
    };
    GM_registerMenuCommand("清除 SteamPY Key 价格缓存", () => {
      CacheUtils.updateCacheKeysList([]);
      CacheUtils.getAllCacheKeys().forEach((key) => GM_deleteValue(key));
      alert("SteamPY Key 价格缓存已清除");
    });
    const currentUrl = document.location.href;
    if (currentUrl.includes("steampy.com/")) {
      syncSteampyTokenOnSteampyPage({ logPrefix: "[SteamPY价格脚本]" });
    } else if (currentUrl.includes("keylol.com/")) {
      const token = getAccessToken();
      if (!token) {
        console.warn(
          "[SteamPY价格脚本] 未检测到 AccessToken，价格查询可能失败。请先访问 steampy.com 登录并同步 AccessToken 后刷新页面。"
        );
        showTopNotice(
          "提示：未检测到 SteamPY AccessToken。请先访问 steampy.com 登录并同步 AccessToken 后刷新页面以查看价格。",
          false
        );
        return;
      }
      if (document.readyState === "complete") {
        init();
      } else {
        window.addEventListener("load", init);
      }
    }
  }

  // src/userscripts/keylol_to_steampy_price.user.js
  startKeylolSteampyPrice();
})();
