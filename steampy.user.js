// ==UserScript==
// @name            SteamPy Plus
// @name:zh-CN      SteamPy Plus
// @name:en         SteamPy Plus
// @namespace       http://github.com/blue-bird1/tampermonkey-script
// @version         5.9.0
// @description     增强购买Steampy密钥的体验，增加筛选功能，支持鼠标中键打开Steam页面。
// @description:en  Enhance the experience of purchasing Steampy keys, add filter functionality, and support opening Steam pages with the middle mouse button.
// @match           https://steampy.com/*
// @grant           GM_setValue
// @grant           GM_getValue
// @grant           GM_xmlhttpRequest
// @grant           GM_registerMenuCommand
// @grant           GM_notification
// @icon            https://steampy.com/logo.ico
// @require         https://scriptcat.org/lib/637/1.4.8/ajaxHooker.js#sha256=dTF50feumqJW36kBpbf6+LguSLAtLr7CEs3oPmyfbiM=
// @require         https://scriptcat.org/lib/513/2.1.0/ElementGetter.js#sha256=aQF7JFfhQ7Hi+weLrBlOsY24Z2ORjaxgZNoni7pAz5U=
// @require         https://scriptcat.org/lib/532/1.0.2/ajax.js#sha384-oDDglpYUiMPlZ/QOkx2727Nl9Pw5b5BEX7IZ/5sEgbiboYYMDfwqHbMAk7X7bo/k
// @require         https://cdnjs.cloudflare.com/ajax/libs/jquery/3.3.1/jquery.min.js
// @connect         steampy.com
// @connect         store.steampowered.com
// @connect         api.steampowered.com
// @run-at          document-start
// @license         MIT
// @downloadURL     https://update.greasyfork.org/scripts/549676/SteamPy%20Plus.user.js
// @updateURL       https://update.greasyfork.org/scripts/549676/SteamPy%20Plus.meta.js
// ==/UserScript==

/* global ajax, ajaxHooker, elmGetter, $ */

(() => {
  // src/lib/steampy/steampy-plus-ajax-hooks.js
  function installSteamPyAjaxHooks({ ajaxHooker: ajaxHooker2, jQuery, onHotGames }) {
    ajaxHooker2.hook((request) => {
      if (request.url.includes("/xboot/steamGame/keyHot")) {
        request.response = (response) => {
          try {
            const data = JSON.parse(response.responseText);
            onHotGames(data);
            response.responseText = JSON.stringify(data);
          } catch (error) {
            console.error("keyHot接口数据处理失败：", error);
          }
        };
      } else if (request.url.includes("/xboot/steamGame/getOne")) {
        request.response = (response) => {
          try {
            const data = JSON.parse(response.responseText);
            if (data.code !== 200 || data.success !== true) {
              console.log("getOne接口数据处理失败：", data);
              return;
            }
            const target = jQuery(".market-content > .market-detail > div:nth-child(3)");
            if (!target.find("[data-steam-py-plus-sales]").length) {
              target.append(`<div data-steam-py-plus-sales class="ht100 mt-50" style="flex-wrap: wrap;"><span class="f20-rem mt-20-rem ml-20-rem">历史销售数量 ${data.result.keyTx}</span></div>`);
            }
          } catch (error) {
            console.error("getOne接口数据处理失败：", error);
          }
        };
      }
      return request;
    });
  }

  // src/lib/steampy/steampy-plus-buyer.js
  function sameList(first, second) {
    return first.length === second.length && first.every((item, index) => item === second[index]);
  }
  function listSignature(list, vm) {
    const form = vm.searchForm || {};
    const formPart = [
      form.pageNumber,
      form.pageSize,
      form.sort,
      form.order,
      form.startDate,
      form.endDate,
      form.gameName || form.keywords || form.name || ""
    ].join("|");
    return `${formPart}::${list.map((game) => game?.id || game?.gameId || game?.appId || game?.gameName || "").join(",")}`;
  }
  function captureSourceList(vm) {
    if (!Array.isArray(vm?.gameList) || vm.__steamPyPlusApplyingFilter) return;
    if (vm.gameList === vm.__steamPyPlusLastFilteredList) return;
    const signature = listSignature(vm.gameList, vm);
    if (signature === vm.__steamPyPlusLastFilteredSignature) return;
    vm.__steamPyPlusOriginalGameList = vm.gameList.slice();
    vm.__steamPyPlusOriginalSignature = signature;
  }
  function applySavedFilter(vm, shouldShow) {
    if (!Array.isArray(vm?.gameList)) return false;
    captureSourceList(vm);
    const source = vm.__steamPyPlusOriginalGameList || vm.gameList.slice();
    const nextList = source.filter(shouldShow);
    if (sameList(nextList, vm.gameList)) return false;
    vm.__steamPyPlusApplyingFilter = true;
    vm.gameList = nextList;
    vm.__steamPyPlusLastFilteredList = nextList;
    vm.__steamPyPlusLastFilteredSignature = listSignature(nextList, vm);
    vm.$nextTick?.(() => {
      vm.__steamPyPlusApplyingFilter = false;
    });
    return true;
  }
  function addUpdatedHook(element, callback) {
    const options = element?.__vue__?.$options;
    if (!options) return false;
    if (!options.updated) options.updated = [];
    else if (!Array.isArray(options.updated)) options.updated = [options.updated];
    options.updated.push(function updatedHook(...args) {
      callback.apply(this, args);
    });
    return true;
  }
  function walkVue3Components(component, visitor, seen = /* @__PURE__ */ new Set()) {
    if (!component || seen.has(component)) return null;
    seen.add(component);
    const matched = visitor(component);
    return matched || walkVue3VNode(component.subTree, visitor, seen);
  }
  function walkVue3VNode(vnode, visitor, seen) {
    if (!vnode) return null;
    if (vnode.component) {
      const matched = walkVue3Components(vnode.component, visitor, seen);
      if (matched) return matched;
    }
    const children = vnode.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        const matched = walkVue3VNode(child, visitor, seen);
        if (matched) return matched;
      }
    } else if (children && typeof children === "object") {
      for (const child of Object.values(children)) {
        const values = Array.isArray(child) ? child : [child];
        for (const value of values) {
          const matched = walkVue3VNode(value, visitor, seen);
          if (matched) return matched;
        }
      }
    }
    return null;
  }
  function hasGameBlock(component) {
    const element = component?.subTree?.el || component?.vnode?.el;
    return Boolean(element?.querySelector?.(".gameblock") || element?.matches?.(".gameblock"));
  }
  function findVue3BuyerVm({ silent = false } = {}) {
    const root = document.querySelector("#app")?._vnode?.component;
    if (!root) {
      if (!silent) console.warn("[SteamPy Plus] 未找到 Vue3 根组件");
      return null;
    }
    const match = walkVue3Components(root, (component) => {
      const proxy = component.proxy;
      if (!Array.isArray(proxy?.gameList) || typeof proxy.getGameList !== "function" || typeof proxy.goToChoose !== "function") return null;
      if (!hasGameBlock(component) && typeof proxy.total !== "number") return null;
      return proxy;
    });
    if (!match && !silent) console.warn("[SteamPy Plus] 未找到新版 CDKey 买家 Vue 实例");
    return match;
  }
  function createSteamPyBuyerController({ elmGetter: elmGetter2, jQuery, filter, rating }) {
    let legacyVm = null;
    let proVm = null;
    let legacyStarted = false;
    let proStarted = false;
    function processCards(vm) {
      rating.processCards(document.querySelectorAll(".gameblock"), vm?.gameList, vm?.__steamPyPlusOriginalGameList);
    }
    function applyLegacy() {
      if (!legacyVm) legacyVm = jQuery(".game_layout .game_layout").get(0)?.__vue__ || null;
      if (!legacyVm) return;
      applySavedFilter(legacyVm, filter.shouldShow);
      legacyVm.$nextTick?.(() => processCards(legacyVm));
    }
    function applyPro() {
      if (!proVm) proVm = findVue3BuyerVm({ silent: true });
      if (!proVm) return;
      applySavedFilter(proVm, filter.shouldShow);
      proVm.$nextTick?.(() => processCards(proVm));
    }
    async function startLegacy() {
      if (legacyStarted) return;
      await elmGetter2.get("div.ivu-tabs-content div.flex-row.jc-space-flex-start.flex-wrap.w-auto");
      legacyVm = jQuery(".game_layout .game_layout").get(0)?.__vue__ || null;
      const tabPane = jQuery(".ivu-tabs-tabpane").get(0);
      addUpdatedHook(tabPane, () => applyLegacy());
      setTimeout(() => applyLegacy(), 600);
      legacyStarted = true;
    }
    async function waitForProVm() {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const vm = findVue3BuyerVm({ silent: true });
        if (vm) return vm;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return null;
    }
    function installProWatcher(vm) {
      if (vm.__steamPyPlusWatcherInstalled || typeof vm.$watch !== "function") return;
      vm.__steamPyPlusWatcherInstalled = true;
      vm.__steamPyPlusUnwatch = vm.$watch("gameList", () => {
        captureSourceList(vm);
        applyPro();
        vm.$nextTick?.(() => processCards(vm));
      }, { deep: false });
    }
    async function startPro() {
      if (proStarted) return;
      await elmGetter2.get(".tag.flex-row.align-items-center");
      await elmGetter2.get(".gameblock");
      proVm = await waitForProVm();
      if (!proVm) {
        console.warn("[SteamPy Plus] 新版 CDKey 买家页初始化失败：未找到 Vue3 买家实例");
        return;
      }
      captureSourceList(proVm);
      installProWatcher(proVm);
      applyPro();
      proStarted = true;
    }
    function applyCurrent(pathname) {
      if (pathname.startsWith("/pro/cdKey/cdKey")) applyPro();
      else if (pathname.startsWith("/cdKey/cdKey")) applyLegacy();
    }
    function cleanupLegacy() {
      legacyVm = null;
      legacyStarted = false;
    }
    function cleanupPro() {
      if (proVm?.__steamPyPlusUnwatch) proVm.__steamPyPlusUnwatch();
      if (proVm) proVm.__steamPyPlusWatcherInstalled = false;
      proVm = null;
      proStarted = false;
    }
    return { applyCurrent, cleanupLegacy, cleanupPro, startLegacy, startPro };
  }

  // src/lib/steampy/steampy-plus-filter.js
  var FILTER_STORAGE_KEY = "steamPriceFilterState";
  var DEFAULT_FILTER_STATE = { minPrice: 0, maxPrice: 9999, isActive: false };
  var INPUT_STYLE = "width:.7rem;height:.28rem;padding:0 .08rem;border:1px solid #ccc;border-radius:.04rem;box-sizing:border-box;font-size:.13rem;line-height:.12rem;";
  var PRESET_STYLE = "padding:.04rem .1rem;border-radius:.04rem;cursor:pointer;font-size:.13rem;border:1px solid #ddd;color:#666;background:transparent;transition:all .2s;box-sizing:border-box;height:.25rem;line-height:.17rem;";
  function loadFilterState() {
    const saved = GM_getValue(FILTER_STORAGE_KEY, null);
    if (!saved) return { ...DEFAULT_FILTER_STATE };
    try {
      return { ...DEFAULT_FILTER_STATE, ...JSON.parse(saved) };
    } catch (error) {
      console.warn("[SteamPy Plus] 价格筛选配置无效，已使用默认值", error);
      return { ...DEFAULT_FILTER_STATE };
    }
  }
  function createSteamPyPriceFilter({ libraryManager, onApply }) {
    const state = loadFilterState();
    function save() {
      GM_setValue(FILTER_STORAGE_KEY, JSON.stringify(state));
    }
    function shouldShow(game) {
      const price = Number(game?.keyPrice);
      const matchesPrice = !state.isActive || price >= state.minPrice && price <= state.maxPrice;
      return matchesPrice && !libraryManager.isGameOwned(game?.appId) && !libraryManager.isGameIgnored(game?.appId);
    }
    function apply() {
      onApply();
    }
    function syncInputs() {
      const minInput = document.getElementById("priceFilterMin");
      const maxInput = document.getElementById("priceFilterMax");
      if (state.isActive && minInput) minInput.value = state.minPrice;
      if (state.isActive && maxInput) maxInput.value = state.maxPrice;
    }
    function updatePresets(highlight = true) {
      document.querySelectorAll(".tagBtn[data-steam-py-plus-min]").forEach((button) => {
        const matches = state.isActive && state.minPrice === Number(button.dataset.steamPyPlusMin) && state.maxPrice === Number(button.dataset.steamPyPlusMax);
        button.style.cssText = highlight && matches ? `${PRESET_STYLE}border:1px solid #409EFF;color:#fff;background:#409EFF;` : PRESET_STYLE;
      });
    }
    function createPreset(text, min, max) {
      const button = document.createElement("div");
      button.className = "tagBtn";
      button.dataset.steamPyPlusMin = min;
      button.dataset.steamPyPlusMax = max;
      button.textContent = text;
      button.onclick = () => {
        Object.assign(state, { minPrice: min, maxPrice: max, isActive: true });
        save();
        syncInputs();
        apply();
        updatePresets();
      };
      return button;
    }
    function mount() {
      if (document.getElementById("priceFilterContainer")) return;
      const target = document.querySelector(".tag.flex-row.align-items-center");
      if (!target) return;
      const container = document.createElement("div");
      container.id = "priceFilterContainer";
      container.className = "ml-5-rem flex-row align-items-center";
      container.style.cssText = "font-family:Arial,sans-serif;font-size:.13rem;gap:.08rem;padding:.08rem;border-radius:.04rem;height:.25rem;box-sizing:border-box;";
      const title = document.createElement("span");
      title.className = "tag-titleOne ml-3-rem";
      title.textContent = "价格筛选";
      title.style.fontWeight = "bold";
      const presets = document.createElement("div");
      presets.className = "flex-row jc-space-flex-start align-items-center pr5-rem";
      presets.style.gap = ".08rem";
      presets.append(createPreset("0-20元", 0, 20), createPreset("20元以上", 20, 9999));
      const inputs = document.createElement("div");
      inputs.className = "flex-row align-items-center";
      inputs.style.gap = ".08rem";
      const minInput = document.createElement("input");
      minInput.id = "priceFilterMin";
      minInput.type = "number";
      minInput.min = 0;
      minInput.placeholder = "最低价";
      minInput.style.cssText = INPUT_STYLE;
      minInput.addEventListener("input", (event) => {
        state.minPrice = Number.parseFloat(event.target.value) || 0;
        state.isActive = true;
        save();
      });
      const maxInput = document.createElement("input");
      maxInput.id = "priceFilterMax";
      maxInput.type = "number";
      maxInput.min = 0;
      maxInput.placeholder = "最高价";
      maxInput.style.cssText = INPUT_STYLE;
      maxInput.addEventListener("input", (event) => {
        state.maxPrice = Number.parseFloat(event.target.value) || 9999;
        state.isActive = true;
        save();
      });
      const button = document.createElement("button");
      button.className = "ivu-btn ivu-btn-default ivu-btn-sm";
      button.textContent = "筛选";
      button.style.cssText = "margin-left:.04rem;padding:.04rem .12rem;cursor:pointer;background:#409EFF;color:#fff;border:0;border-radius:.04rem;font-size:.13rem;height:.28rem;line-height:.2rem;box-sizing:border-box;";
      button.onclick = () => {
        apply();
        updatePresets(false);
      };
      inputs.append(minInput, document.createTextNode("-"), maxInput, button);
      container.append(title, presets, inputs);
      target.appendChild(container);
      syncInputs();
      updatePresets();
    }
    return { apply, mount, shouldShow };
  }

  // src/lib/steampy/steampy-plus-rating.js
  var RATING_CLASSES = [
    "overwhelmingly-positive",
    "very-positive",
    "positive",
    "mixed",
    "negative",
    "very-negative"
  ];
  function normalizeAppId(appId) {
    const parsed = Number.parseInt(appId, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  function getGameAppId(gameSource) {
    return normalizeAppId(typeof gameSource === "object" ? gameSource?.appId : gameSource);
  }
  function getSteamAppId(gameBlock, gameSource) {
    const fallbackAppId = getGameAppId(gameSource);
    if (fallbackAppId) return fallbackAppId;
    const iconImage = gameBlock.querySelector(".cdkGameIcon");
    const imageUrl = iconImage?.dataset.src || iconImage?.src;
    const match = imageUrl?.match(/steam\/apps\/(\d+)/);
    return match ? normalizeAppId(match[1]) : null;
  }
  function getRatingStyle(rating) {
    const percent = Math.round(rating * 100);
    if (percent >= 90) return ["好评如潮", "overwhelmingly-positive"];
    if (percent >= 80) return ["特别好评", "very-positive"];
    if (percent >= 70) return ["多半好评", "positive"];
    if (percent >= 40) return ["褒贬不一", "mixed"];
    if (percent >= 20) return ["多半差评", "negative"];
    return ["特别差评", "very-negative"];
  }
  function createSteamPyRatingEnhancer({ libraryManager }) {
    let hotGameData = { result: { content: [] } };
    function setHotGameData(data) {
      hotGameData = data || { result: { content: [] } };
    }
    function findRating(appId, gameSource, extraGames = []) {
      const sourceRating = typeof gameSource === "object" ? Number(gameSource?.rating) : 0;
      if (sourceRating > 0) return sourceRating;
      const appIdNumber = Number(appId);
      const games = [...hotGameData.result?.content || [], ...extraGames];
      return games.find((game) => Number(game.appId) === appIdNumber && Number(game.rating) > 0)?.rating || 0;
    }
    function updateCard(gameBlock, gameSource, extraGames) {
      if (!gameBlock) return;
      const appId = getSteamAppId(gameBlock, gameSource);
      if (!appId) return;
      if (libraryManager.getState().wish.includes(appId)) {
        gameBlock.querySelector(".gameName")?.classList.add("bg-blue");
      }
      const gameHead = gameBlock.querySelector(".gameHead");
      if (!gameHead) return;
      const ratingElement = gameHead.querySelector(".gameRating");
      const rating = findRating(appId, gameSource, extraGames);
      if (rating <= 0) {
        ratingElement?.remove();
        return;
      }
      const [text, className] = getRatingStyle(rating);
      if (ratingElement) {
        ratingElement.textContent = text;
        ratingElement.classList.remove(...RATING_CLASSES);
        ratingElement.classList.add(className);
        return;
      }
      const newRatingElement = document.createElement("div");
      newRatingElement.className = `gameRating ${className}`;
      newRatingElement.textContent = text;
      gameHead.appendChild(newRatingElement);
    }
    function processOpen(gameBlock, gameSource) {
      if (gameBlock.dataset.steamPyPlusOpenBound) return;
      gameBlock.dataset.steamPyPlusOpenBound = "true";
      gameBlock.addEventListener("mousedown", (event) => {
        if (event.button !== 1 || event.ctrlKey || event.shiftKey) return;
        const appId = getSteamAppId(gameBlock, gameSource);
        if (!appId) return;
        event.preventDefault();
        window.open(`https://store.steampowered.com/app/${appId}/`, "_blank");
      });
    }
    function processCards(gameBlocks, games, extraGames) {
      gameBlocks.forEach((gameBlock, index) => {
        const game = games?.[index];
        updateCard(gameBlock, game, extraGames);
        processOpen(gameBlock, game);
      });
    }
    function injectStyle() {
      document.getElementById("steamPyPlusRatingStyle")?.remove();
      const style = document.createElement("style");
      style.id = "steamPyPlusRatingStyle";
      style.textContent = `
      .gameHead .gameRating { padding: 0 8px !important; height: .3rem !important; position: absolute !important; top: 0 !important; left: 0 !important; color: #fff !important; text-align: center !important; line-height: .3rem !important; border-radius: .09rem 0 0 0 !important; font-size: .12rem !important; font-weight: bold !important; z-index: 10 !important; white-space: nowrap !important; }
      .gameRating.overwhelmingly-positive { background: #4CAF50 !important; }
      .gameRating.very-positive { background: #8BC34A !important; }
      .gameRating.positive { background: #CDDC39 !important; color: #333 !important; }
      .gameRating.mixed { background: #FFC107 !important; color: #333 !important; }
      .gameRating.negative { background: #FF9800 !important; }
      .gameRating.very-negative { background: #F44336 !important; }
    `;
      document.head.appendChild(style);
    }
    return { getSteamAppId, injectStyle, processCards, setHotGameData };
  }

  // src/lib/steampy/game-manager.js
  var STEAMPY_BASE_URL = "https://steampy.com/";
  var STEAMPY_LIST_SALE_PATH = "xboot/steamKeySale/listSale";
  function readSteampyPageToken() {
    return window.localStorage.getItem("accessToken");
  }
  function createSteampyApiRequest(ajax2) {
    return function requestSteampyApi(url, method, data) {
      return ajax2(url, {
        method,
        data,
        responseType: "json",
        headers: {
          Accesstoken: readSteampyPageToken()
        },
        _nocatch: true
      });
    };
  }

  // src/lib/steampy/steampy-plus-sale-cache.js
  var CACHE_KEY = `${STEAMPY_LIST_SALE_PATH}_listSaleCache`;
  var CACHE_DURATION_MS = 12 * 60 * 60 * 1e3;
  function createSteamPySaleListClient({ ajax: ajax2 }) {
    const requestApi = createSteampyApiRequest(ajax2);
    function getSaleList(gameId) {
      const cache = GM_getValue(CACHE_KEY, {});
      const cached = cache[gameId];
      if (cached?.expireTime > Date.now()) return Promise.resolve(cached.data);
      return requestApi(`${STEAMPY_BASE_URL}${STEAMPY_LIST_SALE_PATH}`, "GET", {
        gameId,
        pageNumber: 1,
        pageSize: 20,
        sort: "keyPrice",
        order: "asc",
        startDate: "",
        endDate: ""
      }).then((data) => {
        GM_setValue(CACHE_KEY, { ...cache, [gameId]: { data, expireTime: Date.now() + CACHE_DURATION_MS } });
        return data;
      });
    }
    return { getSaleList };
  }

  // src/lib/steampy/steampy-plus-seller.js
  function createSteamPySellerController({ elmGetter: elmGetter2, jQuery, getSaleList }) {
    let initialized = false;
    function addHistoricalPrice(modal, gameData, vm) {
      const label = modal.find(".mt-15.f15.fw500 .color-red.f12-rem");
      if (!label.length || gameData?.hisPrice === null || modal.find(".his-price-tag").length) return;
      const historyPrice = document.createElement("span");
      historyPrice.className = "his-price-tag color-blue f12-rem ml-10";
      historyPrice.textContent = ` 历史最低价格: ￥${gameData.hisPrice.toFixed(2)}`;
      label.after(historyPrice);
      vm.cdkPrice = (Math.round(Number(gameData.keyPrice) * 10) - 1) / 10;
    }
    async function startModalListener() {
      await elmGetter2.get("#main > div.main > div.single-page-con > div > div");
      const vm = jQuery("#main > div.main > div.single-page-con > div > div").get(0)?.__vue__;
      if (!vm || vm.__steamPyPlusGoToChoosePatched) return;
      const originalGoToChoose = vm.goToChoose;
      if (typeof originalGoToChoose !== "function") return;
      vm.__steamPyPlusGoToChoosePatched = true;
      vm.goToChoose = function patchedGoToChoose(index) {
        originalGoToChoose.call(this, index);
        this.$nextTick(() => addHistoricalPrice(jQuery(".ivu-modal").filter(":visible"), this.modalGamList[index], this));
      };
    }
    async function updateSellRows(vm) {
      await elmGetter2.get(".orderOne.bg-white .list-item");
      jQuery(".orderOne.bg-white .list-item").each(async (index, item) => {
        const data = vm.sellList?.[index];
        const priceElement = item.querySelector("div:nth-child(7)");
        if (!data || !priceElement) return;
        const selfPrice = data.keyPrice;
        priceElement.innerText = `${selfPrice}`;
        priceElement.classList.remove("color-red");
        if (data.stock === 0) return;
        try {
          const saleData = await getSaleList(data.gameId);
          if (saleData.code !== 200) {
            console.error(saleData.msg);
            return;
          }
          const saleList = saleData.result?.content || [];
          const lowestPrice = saleList[0]?.keyPrice;
          if (lowestPrice === void 0 || lowestPrice >= selfPrice) return;
          let order = 1;
          for (const seller of saleList) {
            if (seller.saleId === data.sellerId) break;
            if (seller.keyPrice < selfPrice) order += seller.stock;
          }
          if (order !== 1) {
            priceElement.classList.add("color-red");
            priceElement.innerText = `${selfPrice} 最低价${lowestPrice}`;
            priceElement.setAttribute("data-rawtext", `${selfPrice}`);
          }
        } catch (error) {
          console.error("[SteamPy Plus] 查询卖家报价失败", error);
        }
      });
    }
    async function startSellListListener() {
      const elements = await elmGetter2.get("#main > div.main > div.single-page-con > div.single-page > div:has(.cdkTrade-layout)");
      const vm = elements?.[0]?.__vue__;
      if (!vm || vm.__steamPyPlusSellWatcher || typeof vm.$watch !== "function") return;
      vm.__steamPyPlusSellWatcher = true;
      vm.$watch("sellList", function onSellListChanged() {
        if (vm.sellList === void 0) return;
        this.$nextTick(() => updateSellRows(vm));
      }, { immediate: true });
    }
    async function addQuantitySort() {
      try {
        const parent = await elmGetter2.get(".flex-row > .c-point.flex-row.align-items-center");
        if (!parent?.length) return;
        const buttons = parent.find(".ml-5-rem.c-point.tagBtn");
        if (!buttons.length || parent.find("[data-steam-py-plus-quantity-sort]").length) return;
        const attributes = {};
        jQuery.each(buttons.first()[0].attributes, (_, attribute) => {
          if (attribute.name.startsWith("data-v-")) attributes[attribute.name] = attribute.value;
        });
        const form = await elmGetter2.get("#main > div.main > div.single-page-con > div > div");
        const formVm = form?.[0]?.__vue__;
        if (!formVm) return;
        const quantityButton = jQuery("<div>").addClass("ml-5-rem c-point tagBtn").attr(attributes).attr("data-steam-py-plus-quantity-sort", "true").append(jQuery("<span>").addClass("tag-title").text("数量").attr(attributes));
        const sortByStock = function sortByStock2() {
          parent.find(".ml-5-rem.c-point.tagBtn").removeClass("active");
          jQuery(this).addClass("active");
          formVm.sellForm.sort = "stock";
          formVm.sellForm.pageNumber = 1;
          formVm.getSellData();
        };
        quantityButton.on("click", sortByStock);
        buttons.on("click", sortByStock);
        buttons.last().after(quantityButton);
      } catch (error) {
        console.error('添加"数量"排序按钮失败：', error);
      }
    }
    async function start() {
      if (initialized) return;
      await Promise.all([startModalListener(), addQuantitySort(), startSellListListener()]);
      initialized = true;
    }
    function cleanup() {
      initialized = false;
    }
    return { cleanup, start };
  }

  // src/lib/steampy/steam-library.js
  var STEAM_GAME_LIST_KEY = "steamGameList";
  var FAMILY_LIBRARY_ENABLED_KEY = "steampyFamilyLibraryEnabled";
  var IGNORED_GAMES_ENABLED_KEY = "steampyIgnoredGamesEnabled";
  var STEAM_DYNAMIC_STORE_URL = "https://store.steampowered.com/dynamicstore/userdata/";
  var STEAM_POINTS_CONFIG_URL = "https://store.steampowered.com/pointssummary/ajaxgetasyncconfig";
  var STEAM_SHARED_LIBRARY_URL = "https://api.steampowered.com/IFamilyGroupsService/GetSharedLibraryApps/v1/";
  var NOTIFICATION_TITLE = "SteamPy Plus";
  var FAMILY_LIBRARY_MENU_ID = "steam-py-plus-family-library";
  var IGNORED_GAMES_MENU_ID = "steam-py-plus-ignored-games";
  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function normalizeAppId2(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label} 包含无效 AppID`);
    }
    return value;
  }
  function normalizeAppIds(value, label) {
    if (!Array.isArray(value)) {
      throw new Error(`${label} 格式不正确`);
    }
    return [...new Set(value.map((appId) => normalizeAppId2(appId, label)))];
  }
  function normalizeCachedAppIds(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    return [...new Set(value.filter((appId) => Number.isSafeInteger(appId) && appId > 0))];
  }
  function normalizeDynamicStoreAppId(value, label) {
    if (typeof value === "number") {
      return normalizeAppId2(value, label);
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      return normalizeAppId2(Number(value), label);
    }
    throw new Error(`${label} 包含无效 AppID`);
  }
  function normalizeIgnoredAppIds(value) {
    let appIds;
    if (Array.isArray(value)) {
      appIds = value;
    } else if (isRecord(value)) {
      appIds = Object.keys(value);
    } else {
      throw new Error("Steam 已忽略游戏格式不正确");
    }
    return [...new Set(appIds.map((appId) => normalizeDynamicStoreAppId(appId, "Steam 已忽略游戏")))];
  }
  function normalizeOpaqueList(value) {
    return Array.isArray(value) ? value.slice() : [];
  }
  function normalizePackageIds(value) {
    if (!Array.isArray(value)) {
      throw new Error("Steam 已拥有礼包格式不正确");
    }
    return value.slice();
  }
  function normalizeCachedState(value) {
    if (!isRecord(value)) {
      return { own: [], wish: [], sub: [], family: [], ignored: [] };
    }
    return {
      own: normalizeCachedAppIds(value.own),
      wish: normalizeCachedAppIds(value.wish),
      sub: normalizeOpaqueList(value.sub),
      family: normalizeCachedAppIds(value.family),
      ignored: normalizeCachedAppIds(value.ignored)
    };
  }
  function loadState() {
    const raw = GM_getValue(STEAM_GAME_LIST_KEY, "");
    if (!raw) {
      return { own: [], wish: [], sub: [], family: [], ignored: [] };
    }
    try {
      return normalizeCachedState(JSON.parse(raw));
    } catch (error) {
      console.warn("[SteamPy Plus] Steam 数据缓存格式不正确，已忽略", error);
      return { own: [], wish: [], sub: [], family: [], ignored: [] };
    }
  }
  function saveState(state) {
    GM_setValue(STEAM_GAME_LIST_KEY, JSON.stringify(state));
  }
  function readFamilyEnabled() {
    return GM_getValue(FAMILY_LIBRARY_ENABLED_KEY, false) === true;
  }
  function readIgnoredGamesEnabled() {
    return GM_getValue(IGNORED_GAMES_ENABLED_KEY, false) === true;
  }
  function notify(text) {
    try {
      GM_notification({
        title: NOTIFICATION_TITLE,
        text,
        timeout: 3e3
      });
    } catch (error) {
      console.log(`${NOTIFICATION_TITLE}: ${text}`, error);
    }
  }
  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }
  function parseDynamicStoreData(data) {
    if (!isRecord(data)) {
      throw new Error("Steam 自有库响应格式不正确");
    }
    return {
      own: normalizeAppIds(data.rgOwnedApps, "Steam 自有库"),
      wish: normalizeAppIds(data.rgWishlist, "Steam 愿望单"),
      sub: normalizePackageIds(data.rgOwnedPackages),
      ignored: normalizeIgnoredAppIds(data.rgIgnoredApps)
    };
  }
  function normalizeSteamId(value, label) {
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`${label} 格式不正确`);
    }
    const steamId = String(value).trim();
    if (!/^\d+$/.test(steamId)) {
      throw new Error(`${label} 格式不正确`);
    }
    return steamId;
  }
  function parseFamilyLibraryData(data) {
    if (!isRecord(data) || !isRecord(data.response)) {
      throw new Error("Steam 家庭库响应格式不正确");
    }
    const { response } = data;
    if (!Array.isArray(response.apps)) {
      throw new Error("Steam 家庭库游戏列表格式不正确");
    }
    const ownerSteamId = normalizeSteamId(response.owner_steamid, "Steam 家庭库所有者");
    const familyAppIds = response.apps.map((app, index) => {
      if (!isRecord(app) || !Array.isArray(app.owner_steamids) || typeof app.exclude_reason !== "number") {
        throw new Error(`Steam 家庭库游戏 #${index + 1} 格式不正确`);
      }
      const appId = normalizeAppId2(app.appid, "Steam 家庭库");
      const ownerSteamIds = app.owner_steamids.map(
        (steamId) => normalizeSteamId(steamId, `Steam 家庭库游戏 #${index + 1} 的所有者`)
      );
      return app.exclude_reason === 0 && !ownerSteamIds.includes(ownerSteamId) ? appId : null;
    });
    return [...new Set(familyAppIds.filter((appId) => appId !== null))];
  }
  async function requestDynamicStoreData() {
    const data = await ajax(STEAM_DYNAMIC_STORE_URL, {
      method: "GET",
      responseType: "json",
      _nocatch: true
    });
    return parseDynamicStoreData(data);
  }
  async function requestFamilyLibraryData() {
    const config = await ajax(STEAM_POINTS_CONFIG_URL, {
      method: "GET",
      responseType: "json",
      _nocatch: true
    });
    const token = config?.success && isRecord(config.data) ? config.data.webapi_token : null;
    if (typeof token !== "string" || !token.trim()) {
      throw new Error("无法取得 Steam 家庭库访问令牌");
    }
    const data = await ajax(STEAM_SHARED_LIBRARY_URL, {
      method: "GET",
      data: {
        access_token: token,
        family_groupid: 0,
        include_excluded: true,
        include_free: true,
        include_non_games: true,
        include_own: true
      },
      responseType: "json",
      _nocatch: true
    });
    return parseFamilyLibraryData(data);
  }
  function createSteamLibraryManager({ onChange } = {}) {
    let state = loadState();
    let menusRegistered = false;
    function isFamilyEnabled() {
      return readFamilyEnabled();
    }
    function isIgnoredGamesEnabled() {
      return readIgnoredGamesEnabled();
    }
    function emitChange() {
      if (typeof onChange === "function") {
        onChange();
      }
    }
    async function sync() {
      try {
        const dynamicStoreData = await requestDynamicStoreData();
        let family = state.family;
        if (isFamilyEnabled()) {
          const familyData = await requestFamilyLibraryData();
          family = familyData;
        }
        const nextState = {
          ...dynamicStoreData,
          family
        };
        saveState(nextState);
        state = nextState;
        notify("同步Steam数据成功");
        emitChange();
        return state;
      } catch (error) {
        console.error("[SteamPy Plus] 同步Steam数据失败", error);
        notify(`同步Steam数据失败：${errorMessage(error)}`);
        return null;
      }
    }
    async function toggleFamilyLibrary() {
      const enabled = !isFamilyEnabled();
      GM_setValue(FAMILY_LIBRARY_ENABLED_KEY, enabled);
      registerFamilyMenu();
      if (enabled) {
        notify("已开启：将家庭库游戏视为已拥有，正在同步Steam数据");
        const syncedState = await sync();
        if (!syncedState) {
          notify("家庭库功能仍已开启；同步失败，已保留旧数据");
          emitChange();
        }
        return;
      }
      notify("已关闭：将家庭库游戏视为已拥有");
      emitChange();
    }
    async function toggleIgnoredGames() {
      const enabled = !isIgnoredGamesEnabled();
      GM_setValue(IGNORED_GAMES_ENABLED_KEY, enabled);
      registerIgnoredGamesMenu();
      if (enabled) {
        notify("已开启：隐藏 Steam 已忽略游戏，正在同步Steam数据");
        const syncedState = await sync();
        if (!syncedState) {
          notify("已忽略游戏隐藏功能仍已开启；同步失败，已保留旧数据");
          emitChange();
        }
        return;
      }
      notify("已关闭：隐藏 Steam 已忽略游戏");
      emitChange();
    }
    function registerFamilyMenu() {
      GM_registerMenuCommand(
        `${isFamilyEnabled() ? "关闭" : "开启"}：将家庭库游戏视为已拥有`,
        toggleFamilyLibrary,
        { id: FAMILY_LIBRARY_MENU_ID }
      );
    }
    function registerIgnoredGamesMenu() {
      GM_registerMenuCommand(
        `${isIgnoredGamesEnabled() ? "关闭" : "开启"}：隐藏 Steam 已忽略游戏`,
        toggleIgnoredGames,
        { id: IGNORED_GAMES_MENU_ID }
      );
    }
    function registerMenus() {
      if (menusRegistered) {
        return;
      }
      menusRegistered = true;
      GM_registerMenuCommand("同步Steam数据", sync);
      registerFamilyMenu();
      registerIgnoredGamesMenu();
    }
    function isGameOwned(appId) {
      const parsedAppId = Number(appId);
      if (!Number.isSafeInteger(parsedAppId) || parsedAppId <= 0) {
        return false;
      }
      return state.own.includes(parsedAppId) || isFamilyEnabled() && state.family.includes(parsedAppId);
    }
    function isGameIgnored(appId) {
      const parsedAppId = Number(appId);
      return isIgnoredGamesEnabled() && Number.isSafeInteger(parsedAppId) && parsedAppId > 0 && state.ignored.includes(parsedAppId);
    }
    function getState() {
      return state;
    }
    return {
      registerMenus,
      sync,
      isGameOwned,
      isGameIgnored,
      isFamilyEnabled,
      isIgnoredGamesEnabled,
      getState
    };
  }

  // src/lib/steampy/steampy-plus.js
  var LEGACY_BUYER_PATH = "/cdKey/cdKey";
  var PRO_BUYER_PATH = "/pro/cdKey/cdKey";
  var SELLER_PATH = "/pyUserInfo/sellerCDKey";
  var DETAIL_PATH = "/cdkDetail";
  function startSteamPyPlus({ ajax: ajax2, ajaxHooker: ajaxHooker2, elmGetter: elmGetter2, jQuery }) {
    let buyer;
    const libraryManager = createSteamLibraryManager({
      onChange() {
        buyer?.applyCurrent(location.pathname);
      }
    });
    const rating = createSteamPyRatingEnhancer({ libraryManager });
    const filter = createSteamPyPriceFilter({
      libraryManager,
      onApply() {
        buyer.applyCurrent(location.pathname);
      }
    });
    buyer = createSteamPyBuyerController({ elmGetter: elmGetter2, jQuery, filter, rating });
    const saleListClient = createSteamPySaleListClient({ ajax: ajax2 });
    const seller = createSteamPySellerController({ elmGetter: elmGetter2, jQuery, getSaleList: saleListClient.getSaleList });
    installSteamPyAjaxHooks({ ajaxHooker: ajaxHooker2, jQuery, onHotGames: rating.setHotGameData });
    libraryManager.registerMenus();
    elmGetter2.selector(jQuery);
    let legacyActive = false;
    let proActive = false;
    let sellerActive = false;
    function startBuyer(pathname) {
      if (pathname.startsWith(LEGACY_BUYER_PATH) && !legacyActive) {
        rating.injectStyle();
        buyer.startLegacy().then(() => {
          filter.mount();
          buyer.applyCurrent(pathname);
        });
        legacyActive = true;
      } else if (!pathname.startsWith(LEGACY_BUYER_PATH) && legacyActive) {
        buyer.cleanupLegacy();
        legacyActive = false;
      }
      if (pathname.startsWith(PRO_BUYER_PATH) && !proActive) {
        rating.injectStyle();
        buyer.startPro().then(() => {
          filter.mount();
          buyer.applyCurrent(pathname);
        });
        proActive = true;
      } else if (!pathname.startsWith(PRO_BUYER_PATH) && proActive) {
        buyer.cleanupPro();
        proActive = false;
      }
    }
    function handlePathChange() {
      const pathname = location.pathname;
      startBuyer(pathname);
      if (pathname.startsWith(SELLER_PATH) && !sellerActive) {
        seller.start();
        sellerActive = true;
      } else if (!pathname.startsWith(SELLER_PATH) && sellerActive) {
        seller.cleanup();
        sellerActive = false;
      }
      if (pathname.startsWith(DETAIL_PATH)) console.log("[SteamPy Plus] 进入 CDKey 详情页");
    }
    let lastPath = location.pathname + location.search;
    const { pushState, replaceState } = history;
    history.pushState = function steamPyPlusPushState(...args) {
      pushState.apply(this, args);
      const nextPath = location.pathname + location.search;
      if (nextPath !== lastPath) {
        lastPath = nextPath;
        handlePathChange();
      }
    };
    history.replaceState = function steamPyPlusReplaceState(...args) {
      replaceState.apply(this, args);
      const nextPath = location.pathname + location.search;
      if (nextPath !== lastPath) {
        lastPath = nextPath;
        handlePathChange();
      }
    };
    window.addEventListener("popstate", handlePathChange);
    window.addEventListener("hashchange", handlePathChange);
    handlePathChange();
  }

  // src/userscripts/steampy.user.js
  startSteamPyPlus({ ajax, ajaxHooker, elmGetter, jQuery: $ });
})();
