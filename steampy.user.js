// ==UserScript==
// @name            SteamPy Plus
// @name:zh-CN      SteamPy Plus
// @name:en         SteamPy Plus
// @namespace       http://github.com/blue-bird1/tampermonkey-script
// @version         5.10.5
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
  // src/lib/steampy/access-token.js
  var LOCAL_ACCESS_TOKEN_KEY = "accessToken";
  function readSteampyLocalToken() {
    return window.localStorage.getItem(LOCAL_ACCESS_TOKEN_KEY) || "";
  }

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

  // src/lib/steampy/steampy-plus-advanced-filter.js
  var FILTER_ANCHOR_SELECTOR = ".tag.flex-row.align-items-center";
  var DLC_CONTROL_SELECTOR = "#steamPyPlusHideDlc";
  var ADVANCED_BUTTON_ID = "steamPyPlusAdvancedFilterButton";
  var ADVANCED_DIALOG_ID = "steamPyPlusAdvancedFilterDialog";
  var FIXED_SORT = "sp.keyDaily";
  var FIXED_ORDER = "desc";
  var SUPPORTED_FILTERS = Object.freeze([
    ["lowAmt", "highAmt", "decRange"],
    ["lowDis", "highDis", "decRange"],
    ["hisFlag", null, "str"],
    ["lowVs", "highVs", "decRange"],
    ["kd", null, "int"],
    ["genre", null, "str"],
    ["releaseDay", null, "int"],
    ["reviewScoreDesc", null, "str"],
    ["lowRating", "highRating", "decRange"],
    ["lowReview", "highReview", "intRange"],
    ["lang", null, "str"],
    ["familySharing", null, "str"],
    ["deckVerified", null, "str"],
    ["cards", null, "str"],
    ["publisher", null, "str"]
  ]);
  var SUPPORTED_BY_CODE = new Map(SUPPORTED_FILTERS.map(([code, highCode, type]) => [code, { highCode, type }]));
  function createAbortError() {
    const error = new Error("高级筛选请求已取消");
    error.name = "AbortError";
    return error;
  }
  function isAbortError(error) {
    return error?.name === "AbortError";
  }
  function isVisible(item) {
    return item?.showFlag === "1";
  }
  function compareSortOrder(first, second) {
    return Number(first?.sortOrder) - Number(second?.sortOrder);
  }
  function createEmptyState() {
    return /* @__PURE__ */ Object.create(null);
  }
  function copyState(state) {
    return Object.assign(createEmptyState(), state);
  }
  function validNumber(value) {
    return value !== "" && value !== null && value !== void 0 && Number.isFinite(Number(value));
  }
  function formatRequestValue(value, type) {
    if (!validNumber(value)) return "";
    return type === "decRange" ? Number(value).toFixed(2) : String(Math.trunc(Number(value)));
  }
  function formatValue(value) {
    return validNumber(value) ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(Number(value)) : "";
  }
  function formatOption(option, type) {
    if (option.label) return option.label;
    if (type === "str") return String(option.strValue ?? "");
    if (type === "int") return formatValue(option.lowValue);
    return `${formatValue(option.lowValue)} - ${formatValue(option.highValue)}`;
  }
  function normalizeMetadata(result) {
    if (!Array.isArray(result)) return [];
    return result.filter((group) => isVisible(group) && SUPPORTED_BY_CODE.has(group.code)).map((group) => {
      const supported = SUPPORTED_BY_CODE.get(group.code);
      if (group.type !== supported.type || supported.highCode && group.highCode !== supported.highCode) return null;
      return {
        ...group,
        options: Array.isArray(group.options) ? group.options.filter(isVisible).sort(compareSortOrder) : []
      };
    }).filter(Boolean).sort(compareSortOrder);
  }
  function hasCompleteMetadata(metadata) {
    if (metadata.length !== SUPPORTED_FILTERS.length) return false;
    const codes = new Set(metadata.map((group) => group.code));
    return SUPPORTED_FILTERS.every(([code]) => codes.has(code));
  }
  function mapSteamApp(item, markedItems, markedAppIds) {
    const mapped = { ...item };
    if (Object.hasOwn(item, "miniPrice")) mapped.keyPrice = item.miniPrice;
    if (validNumber(item.oriPrice) && Number(item.oriPrice) > 0 && validNumber(item.miniPrice)) {
      mapped.keyDiscount = Number(item.miniPrice) / Number(item.oriPrice);
    } else {
      delete mapped.keyDiscount;
    }
    markedItems.add(mapped);
    if (mapped.appId !== null && mapped.appId !== void 0) markedAppIds.add(String(mapped.appId));
    return mapped;
  }
  function createSteamPyAdvancedFilterController({
    fetchFilterMetadata,
    fetchSteamAppList,
    fetchSteamGameByAppId,
    setHideDlcSuspended = () => {
    }
  }) {
    let vm = null;
    let originalMethods = null;
    let button = null;
    let dialog = null;
    let metadata = [];
    let draft = createEmptyState();
    let applied = createEmptyState();
    let active = false;
    let mountToken = 0;
    const requestGenerations = { detail: 0, list: 0, metadata: 0 };
    let pausedDlcControl = null;
    const requests = /* @__PURE__ */ new Set();
    const mappedItems = /* @__PURE__ */ new WeakSet();
    const mappedAppIds = /* @__PURE__ */ new Set();
    function showError(message) {
      if (vm?.$Message?.error) vm.$Message.error(message);
      else if (vm?.$message?.error) vm.$message.error(message);
      else console.error(`[SteamPy Plus] ${message}`);
    }
    function currentRequest(token, kind, generation) {
      return vm && token === mountToken && generation === requestGenerations[kind];
    }
    async function request(kind, callback, token) {
      const controller = new AbortController();
      const generation = ++requestGenerations[kind];
      requests.add(controller);
      try {
        const result = await callback(controller.signal);
        if (controller.signal.aborted || !currentRequest(token, kind, generation)) throw createAbortError();
        return result;
      } catch (error) {
        if (controller.signal.aborted || !currentRequest(token, kind, generation)) throw createAbortError();
        throw error;
      } finally {
        requests.delete(controller);
      }
    }
    function pauseDlcFilter() {
      if (pausedDlcControl) return;
      const control = document.querySelector(DLC_CONTROL_SELECTOR);
      pausedDlcControl = control ? {
        control,
        checked: control.checked,
        disabled: control.disabled,
        hadTitle: control.hasAttribute("title"),
        title: control.getAttribute("title")
      } : {};
      if (control) {
        control.disabled = true;
        control.title = "高级筛选接口不返回 DLC 类型";
      }
      setHideDlcSuspended(true);
    }
    function resumeDlcFilter() {
      if (!pausedDlcControl) return;
      setHideDlcSuspended(false);
      const { control, checked, disabled, hadTitle, title } = pausedDlcControl;
      if (control?.isConnected) {
        control.checked = checked;
        control.disabled = disabled;
        if (hadTitle) control.setAttribute("title", title);
        else control.removeAttribute("title");
      }
      pausedDlcControl = null;
    }
    function createParams(source) {
      const params = {
        pageNumber: source?.pageNumber,
        pageSize: source?.pageSize,
        sort: FIXED_SORT,
        order: FIXED_ORDER
      };
      SUPPORTED_FILTERS.forEach(([code, highCode]) => {
        params[code] = "";
        if (highCode) params[highCode] = "";
      });
      metadata.forEach((group) => {
        const optionIndex = applied[group.code];
        if (!Number.isInteger(optionIndex)) return;
        const option = group.options[optionIndex];
        if (!option) return;
        if (group.type === "decRange" || group.type === "intRange") {
          params[group.code] = formatRequestValue(option.lowValue, group.type);
          params[group.highCode] = formatRequestValue(option.highValue, group.type);
        } else if (group.type === "str") {
          params[group.code] = String(option.strValue ?? "");
        } else if (group.type === "int") {
          params[group.code] = formatRequestValue(option.lowValue, group.type);
        }
      });
      return params;
    }
    function refresh(pageNumber = 1) {
      if (!vm?.getGameList) return;
      if (vm.searchForm) vm.searchForm.pageNumber = pageNumber;
      vm.getGameList();
    }
    async function advancedCdkListApi(searchForm) {
      const token = mountToken;
      try {
        const result = await request(
          "list",
          () => fetchSteamAppList(createParams(searchForm)),
          token
        );
        if (!Array.isArray(result?.content)) throw new Error("高级筛选返回的数据格式无效");
        mappedAppIds.clear();
        return {
          success: true,
          result: {
            ...result,
            content: result.content.map((item) => mapSteamApp(item, mappedItems, mappedAppIds))
          }
        };
      } catch (error) {
        if (!isAbortError(error)) showError(error.message || "加载高级筛选结果失败");
        throw error;
      }
    }
    async function advancedGoDetail(index) {
      const game = vm?.gameList?.[index];
      const hasAppId = game?.appId !== null && game?.appId !== void 0;
      const mapped = mappedItems.has(game) || hasAppId && mappedAppIds.has(String(game.appId));
      if (!mapped) return originalMethods.goDetail.call(vm, index);
      if (game && typeof game === "object") mappedItems.add(game);
      try {
        const token = mountToken;
        const result = await request("detail", () => fetchSteamGameByAppId(game.appId), token);
        const gameId = result?.content?.[0]?.id;
        if (!gameId) throw new Error("未找到对应的 SteamPy 商品");
        vm.$router.push({ name: "cdkDetail", query: { name: vm.areas, gameId } });
      } catch (error) {
        if (!isAbortError(error)) showError(error.message || "打开商品详情失败");
      }
    }
    function patchVm() {
      originalMethods = {
        cdkListApi: vm.cdkListApi,
        chooseTag: vm.chooseTag,
        goDetail: vm.goDetail,
        sort: vm.searchForm?.sort,
        order: vm.searchForm?.order
      };
      if (vm.searchForm) {
        vm.searchForm.sort = FIXED_SORT;
        vm.searchForm.order = FIXED_ORDER;
      }
      vm.cdkListApi = advancedCdkListApi;
      vm.chooseTag = function advancedChooseTag(...args) {
        const chooseTag = originalMethods?.chooseTag;
        disable({ refreshList: false });
        return chooseTag?.apply(this, args);
      };
      vm.goDetail = advancedGoDetail;
    }
    function restoreVm() {
      if (!vm || !originalMethods) return;
      vm.cdkListApi = originalMethods.cdkListApi;
      vm.chooseTag = originalMethods.chooseTag;
      vm.goDetail = originalMethods.goDetail;
      if (vm.searchForm) {
        vm.searchForm.sort = originalMethods.sort;
        vm.searchForm.order = originalMethods.order;
      }
      originalMethods = null;
    }
    function disable({ refreshList }) {
      if (!active) return;
      active = false;
      Object.keys(requestGenerations).forEach((key) => {
        requestGenerations[key] += 1;
      });
      requests.forEach((controller) => controller.abort());
      restoreVm();
      resumeDlcFilter();
      if (refreshList) refresh(1);
    }
    function closeDialog() {
      dialog?.remove();
      dialog = null;
    }
    function renderDialog() {
      if (!dialog) return;
      const body = dialog.querySelector("[data-steam-py-plus-advanced-body]");
      body.replaceChildren();
      metadata.forEach((group) => {
        const field = document.createElement("label");
        field.style.cssText = "display:flex;align-items:center;gap:.08rem;min-width:2.6rem;";
        const title = document.createElement("span");
        title.textContent = group.name;
        const select = document.createElement("select");
        select.dataset.steamPyPlusFilterCode = group.code;
        select.style.cssText = "flex:1;min-width:1.4rem;height:.3rem;border:1px solid #dcdee2;border-radius:.04rem;background:#fff;";
        const unlimited = document.createElement("option");
        unlimited.value = "";
        unlimited.textContent = "不限";
        select.append(unlimited);
        group.options.forEach((option, index) => {
          const item = document.createElement("option");
          item.value = String(index);
          item.textContent = formatOption(option, group.type);
          select.append(item);
        });
        const selected = draft[group.code];
        select.value = Number.isInteger(selected) ? String(selected) : "";
        select.addEventListener("change", () => {
          if (select.value === "") delete draft[group.code];
          else draft[group.code] = Number(select.value);
        });
        field.append(title, select);
        body.append(field);
      });
    }
    async function loadMetadata() {
      if (metadata.length) return true;
      try {
        const token = mountToken;
        const nextMetadata = normalizeMetadata(await request("metadata", () => fetchFilterMetadata(), token));
        if (!hasCompleteMetadata(nextMetadata)) throw new Error("高级筛选条件不完整，请稍后重试");
        metadata = nextMetadata;
        return true;
      } catch (error) {
        if (!isAbortError(error)) showError(error.message || "加载高级筛选条件失败");
        return false;
      }
    }
    async function openDialog() {
      if (dialog) return;
      const overlay = document.createElement("div");
      overlay.id = ADVANCED_DIALOG_ID;
      overlay.style.cssText = "position:fixed;z-index:10000;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.38);";
      const panel = document.createElement("section");
      panel.style.cssText = "width:min(7.4rem,92vw);max-height:82vh;overflow:auto;padding:.22rem;border-radius:.08rem;background:#fff;color:#17233d;box-sizing:border-box;";
      const title = document.createElement("h3");
      title.textContent = "高级筛选";
      title.style.cssText = "margin:0 0:.16rem;font-size:.18rem;";
      const body = document.createElement("div");
      body.dataset.steamPyPlusAdvancedBody = "true";
      body.style.cssText = "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.12rem;";
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;justify-content:flex-end;gap:.1rem;margin-top:.2rem;";
      const makeButton = (text, handler) => {
        const element = document.createElement("button");
        element.type = "button";
        element.className = "ivu-btn ivu-btn-default";
        element.textContent = text;
        element.addEventListener("click", handler);
        return element;
      };
      const cancel = makeButton("取消", () => closeDialog());
      const reset = makeButton("重置", () => {
        draft = createEmptyState();
        renderDialog();
      });
      const exit = makeButton("关闭高级筛选", () => {
        disable({ refreshList: true });
        closeDialog();
      });
      const apply = makeButton("应用", () => {
        applied = copyState(draft);
        if (!active) {
          active = true;
          pauseDlcFilter();
          patchVm();
        }
        refresh(1);
        closeDialog();
      });
      apply.className = "ivu-btn ivu-btn-primary";
      apply.disabled = true;
      actions.append(cancel, reset, exit, apply);
      panel.append(title, body, actions);
      overlay.append(panel);
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeDialog();
      });
      document.body.append(overlay);
      dialog = overlay;
      draft = copyState(applied);
      if (await loadMetadata()) {
        renderDialog();
        apply.disabled = false;
      }
    }
    function mount(nextVm) {
      if (!nextVm || typeof nextVm.getGameList !== "function") return false;
      if (vm && vm !== nextVm) cleanup();
      if (vm !== nextVm) mountToken += 1;
      vm = nextVm;
      const anchor = document.querySelector(FILTER_ANCHOR_SELECTOR);
      if (!anchor) return false;
      if (button?.isConnected) return true;
      document.getElementById(ADVANCED_BUTTON_ID)?.remove();
      button = document.createElement("button");
      button.id = ADVANCED_BUTTON_ID;
      button.type = "button";
      button.className = "ivu-btn ivu-btn-default ivu-btn-sm";
      button.textContent = "高级筛选";
      button.style.cssText = "margin-left:.08rem;";
      button.addEventListener("click", () => {
        openDialog();
      });
      anchor.append(button);
      return true;
    }
    function cleanup() {
      mountToken += 1;
      Object.keys(requestGenerations).forEach((key) => {
        requestGenerations[key] += 1;
      });
      requests.forEach((controller) => controller.abort());
      closeDialog();
      disable({ refreshList: false });
      button?.remove();
      button = null;
      vm = null;
      metadata = [];
      mappedAppIds.clear();
      draft = createEmptyState();
      applied = createEmptyState();
    }
    return { cleanup, mount };
  }

  // src/lib/steampy/steampy-plus-buyer.js
  function sameList(first, second) {
    return first.length === second.length && first.every((item, index) => item === second[index]);
  }
  var PRO_BUYER_PAGE_SIZE_STORAGE_KEY = "steamPyPlusProBuyerPageSize";
  var PRO_BUYER_PAGE_SIZE_CONTROL_ID = "steamPyPlusProBuyerPageSize";
  var DEFAULT_PRO_BUYER_PAGE_SIZE = 30;
  var PRO_BUYER_PAGE_SIZE_OPTIONS = Object.freeze([30, 50, 100]);
  function parseProBuyerPageSize(value) {
    const pageSize = Number(value);
    return Number.isInteger(pageSize) && PRO_BUYER_PAGE_SIZE_OPTIONS.includes(pageSize) ? pageSize : null;
  }
  function loadProBuyerPageSize(getValue) {
    return parseProBuyerPageSize(getValue(PRO_BUYER_PAGE_SIZE_STORAGE_KEY, DEFAULT_PRO_BUYER_PAGE_SIZE)) ?? DEFAULT_PRO_BUYER_PAGE_SIZE;
  }
  function removeProBuyerPageSizeControl() {
    document.querySelectorAll("[data-steam-py-plus-pro-page-size-control]").forEach((element) => element.remove());
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
  function createSteamPyBuyerController({
    advancedFilter,
    elmGetter: elmGetter2,
    jQuery,
    filter,
    rating,
    getValue = GM_getValue,
    setValue = GM_setValue
  }) {
    let legacyVm = null;
    let proVm = null;
    let legacyStarted = false;
    let proStarted = false;
    let proStartGeneration = 0;
    let proPageSize = DEFAULT_PRO_BUYER_PAGE_SIZE;
    function processCards(vm) {
      rating.processCards(document.querySelectorAll(".gameblock"), vm?.gameList, vm?.__steamPyPlusOriginalGameList);
    }
    function applyLegacy() {
      if (!legacyVm) legacyVm = jQuery(".game_layout .game_layout").get(0)?.__vue__ || null;
      if (!legacyVm) return;
      applySavedFilter(legacyVm, filter.shouldShow);
      legacyVm.$nextTick?.(() => processCards(legacyVm));
    }
    function mountProPageSizeControl(vm) {
      const pagination = document.querySelector(".page.mt-50-rem > .ivu-page");
      if (!pagination) return;
      const existing = document.getElementById(PRO_BUYER_PAGE_SIZE_CONTROL_ID);
      if (existing && pagination.contains(existing)) {
        existing.value = String(proPageSize);
        return;
      }
      removeProBuyerPageSizeControl();
      const container = document.createElement("label");
      container.className = "ivu-page-total";
      container.dataset.steamPyPlusProPageSizeControl = "true";
      container.htmlFor = PRO_BUYER_PAGE_SIZE_CONTROL_ID;
      container.style.cssText = "display:inline-flex;align-items:center;gap:.06rem;margin-left:.12rem;font-size:.13rem;";
      container.append(document.createTextNode("每页"));
      const select = document.createElement("select");
      select.id = PRO_BUYER_PAGE_SIZE_CONTROL_ID;
      select.className = "ivu-select-selection";
      select.style.cssText = "height:.28rem;min-width:.62rem;padding:0 .08rem;border:1px solid #dcdee2;border-radius:.04rem;background:#fff;color:#515a6e;font-size:.13rem;cursor:pointer;";
      PRO_BUYER_PAGE_SIZE_OPTIONS.forEach((pageSize) => {
        const option = document.createElement("option");
        option.value = String(pageSize);
        option.textContent = String(pageSize);
        select.append(option);
      });
      select.value = String(proPageSize);
      select.addEventListener("change", (event) => {
        const pageSize = parseProBuyerPageSize(event.target.value);
        if (!pageSize) {
          event.target.value = String(proPageSize);
          return;
        }
        proPageSize = pageSize;
        setValue(PRO_BUYER_PAGE_SIZE_STORAGE_KEY, pageSize);
        if (!vm?.searchForm) return;
        vm.searchForm.pageSize = pageSize;
        vm.searchForm.pageNumber = 1;
        if (typeof vm.changePage === "function") vm.changePage(1);
        else vm.getGameList?.();
        scheduleProPageSizeMount(vm);
      });
      container.append(select);
      pagination.append(container);
    }
    function scheduleProPageSizeMount(vm) {
      vm.$nextTick?.(() => {
        if (proVm === vm) mountProPageSizeControl(vm);
      });
    }
    function initializeProPageSize(vm) {
      proPageSize = loadProBuyerPageSize(getValue);
      scheduleProPageSizeMount(vm);
      const currentPageSize = parseProBuyerPageSize(vm?.searchForm?.pageSize);
      if (proPageSize === DEFAULT_PRO_BUYER_PAGE_SIZE || currentPageSize === proPageSize || !vm?.searchForm) return;
      vm.searchForm.pageSize = proPageSize;
      vm.searchForm.pageNumber = 1;
      if (typeof vm.changePage === "function") vm.changePage(1);
      else vm.getGameList?.();
    }
    function applyPro() {
      if (!proVm) proVm = findVue3BuyerVm({ silent: true });
      if (!proVm) return;
      applySavedFilter(proVm, filter.shouldShow);
      scheduleProPageSizeMount(proVm);
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
    async function waitForProVm(isCurrent) {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (!isCurrent()) return null;
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
      const startGeneration = ++proStartGeneration;
      const isCurrent = () => startGeneration === proStartGeneration;
      await elmGetter2.get(".tag.flex-row.align-items-center");
      if (!isCurrent()) return;
      await elmGetter2.get(".gameblock");
      if (!isCurrent()) return;
      const nextProVm = await waitForProVm(isCurrent);
      if (!isCurrent()) return;
      if (!nextProVm) {
        console.warn("[SteamPy Plus] 新版 CDKey 买家页初始化失败：未找到 Vue3 买家实例");
        return;
      }
      proVm = nextProVm;
      captureSourceList(proVm);
      installProWatcher(proVm);
      initializeProPageSize(proVm);
      advancedFilter?.mount(proVm);
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
      proStartGeneration += 1;
      advancedFilter?.cleanup();
      if (proVm?.__steamPyPlusUnwatch) proVm.__steamPyPlusUnwatch();
      if (proVm) proVm.__steamPyPlusWatcherInstalled = false;
      removeProBuyerPageSizeControl();
      proVm = null;
      proStarted = false;
    }
    return { applyCurrent, cleanupLegacy, cleanupPro, startLegacy, startPro };
  }

  // src/lib/steampy/steampy-plus-filter.js
  var FILTER_STORAGE_KEY = "steamPriceFilterState";
  var DEFAULT_FILTER_STATE = {
    minPrice: 0,
    maxPrice: 9999,
    isActive: false,
    hideDlc: false
  };
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
    let hideDlcSuspended = false;
    function save() {
      GM_setValue(FILTER_STORAGE_KEY, JSON.stringify(state));
    }
    function shouldShow(game) {
      const price = Number(game?.keyTxAmt ?? game?.keyPrice);
      const matchesPrice = !state.isActive || price >= state.minPrice && price <= state.maxPrice;
      return matchesPrice && (hideDlcSuspended || !state.hideDlc || game?.steamApp?.type !== "dlc") && !libraryManager.isGameOwned(game?.appId) && !libraryManager.isGameIgnored(game?.appId);
    }
    function setHideDlcSuspended(suspended) {
      hideDlcSuspended = Boolean(suspended);
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
      title.textContent = "筛选";
      title.style.fontWeight = "bold";
      const presets = document.createElement("div");
      presets.className = "flex-row jc-space-flex-start align-items-center pr5-rem";
      presets.style.gap = ".08rem";
      presets.append(createPreset("0-20元", 0, 20), createPreset("20元以上", 20, 9999));
      const inputs = document.createElement("div");
      inputs.className = "flex-row align-items-center";
      inputs.style.gap = ".08rem";
      const hideDlcInput = document.createElement("input");
      hideDlcInput.id = "steamPyPlusHideDlc";
      hideDlcInput.type = "checkbox";
      hideDlcInput.checked = state.hideDlc;
      hideDlcInput.addEventListener("change", (event) => {
        state.hideDlc = event.target.checked;
        save();
        apply();
      });
      const hideDlcLabel = document.createElement("label");
      hideDlcLabel.htmlFor = hideDlcInput.id;
      hideDlcLabel.textContent = "隐藏 DLC";
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
      inputs.append(hideDlcInput, hideDlcLabel, minInput, document.createTextNode("-"), maxInput, button);
      container.append(title, presets, inputs);
      target.appendChild(container);
      syncInputs();
      updatePresets();
    }
    return { apply, mount, setHideDlcSuspended, shouldShow };
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
    const cardAppIds = /* @__PURE__ */ new WeakMap();
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
      const gameName = gameBlock.querySelector(".gameName");
      const appId = getSteamAppId(gameBlock, gameSource);
      if (!appId) {
        gameName?.classList.remove("bg-blue");
        return;
      }
      gameName?.classList.toggle("bg-blue", libraryManager.getState().wish.includes(appId));
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
      const appId = getSteamAppId(gameBlock, gameSource);
      if (appId) {
        cardAppIds.set(gameBlock, appId);
      } else {
        cardAppIds.delete(gameBlock);
      }
      if (gameBlock.dataset.steamPyPlusOpenBound) return;
      gameBlock.dataset.steamPyPlusOpenBound = "true";
      gameBlock.addEventListener("mousedown", (event) => {
        if (event.button !== 1 || event.ctrlKey || event.shiftKey) return;
        const currentAppId = cardAppIds.get(gameBlock);
        if (!currentAppId) return;
        event.preventDefault();
        window.open(`https://store.steampowered.com/app/${currentAppId}/`, "_blank");
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

  // src/lib/steampy/steampy-plus-seller-batch.js
  var STEAM_APP_URL = "https://store.steampowered.com/app/";
  var KEY_SALE_REQUEST_INTERVAL_MS = 10500;
  function waitFor(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  function errorRecord(row, message, column = null, code = "invalid") {
    return {
      code,
      column,
      lineNumber: row?.lineNumber ?? null,
      rawLine: row?.rawLine ?? "",
      message
    };
  }
  function parseCsvLine(line, lineNumber) {
    const fields = [];
    let field = "";
    let quoted = false;
    let afterQuote = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (quoted) {
        if (character === '"') {
          if (line[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            quoted = false;
            afterQuote = true;
          }
        } else {
          field += character;
        }
        continue;
      }
      if (afterQuote) {
        if (character === ",") {
          fields.push(field.trim());
          field = "";
          afterQuote = false;
        } else if (/\s/.test(character)) {
          continue;
        } else {
          return { error: `第 ${lineNumber} 行：引号后只能出现逗号或行尾`, column: fields.length + 1 };
        }
        continue;
      }
      if (character === ",") {
        fields.push(field.trim());
        field = "";
      } else if (character === '"' && field.trim() === "") {
        field = "";
        quoted = true;
      } else {
        field += character;
      }
    }
    if (quoted) return { error: `第 ${lineNumber} 行：引号未闭合（不支持跨行字段）`, column: fields.length + 1 };
    fields.push(field.trim());
    return { fields };
  }
  function parseBatchCsv(input) {
    const text = String(input ?? "").replace(/^\uFEFF/, "");
    const rows = [];
    const errors = [];
    const seenKeys = /* @__PURE__ */ new Map();
    const lines = text.split(/\r?\n/);
    lines.forEach((rawLine, lineIndex) => {
      const lineNumber = lineIndex + 1;
      if (rawLine.trim() === "") return;
      const parsed = parseCsvLine(rawLine, lineNumber);
      if (parsed.error) {
        errors.push({ code: "csv", column: parsed.column, lineNumber, rawLine, message: parsed.error });
        return;
      }
      const fields = parsed.fields;
      if (fields.length < 2 || fields.length > 4) {
        errors.push({ code: "field-count", column: null, lineNumber, rawLine, message: `第 ${lineNumber} 行：CSV 必须有 2 至 4 列` });
        return;
      }
      const [gameName = "", key = "", appId = "", gameId = ""] = fields;
      const row = { lineNumber, rawLine, gameName, key, appId, gameId };
      if (!key) errors.push(errorRecord(row, "key 不能为空", 2, "required-key"));
      if (!gameName && !appId && !gameId) errors.push(errorRecord(row, "至少提供 gameName、appId 或 gameId", null, "missing-locator"));
      if (appId && !/^[1-9][0-9]*$/.test(appId)) errors.push(errorRecord(row, "appId 必须是正整数文本", 3, "invalid-app-id"));
      if (gameId && !/^[1-9][0-9]*$/.test(gameId)) errors.push(errorRecord(row, "gameId 必须是正整数文本", 4, "invalid-game-id"));
      if (key) {
        const previous = seenKeys.get(key);
        if (previous) errors.push(errorRecord(row, `key 与第 ${previous} 行重复`, 2, "duplicate-key"));
        else seenKeys.set(key, lineNumber);
      }
      rows.push(row);
    });
    return { rows, errors };
  }
  function contentOf(response) {
    return response?.result?.content ?? response?.content ?? response?.result ?? response;
  }
  function uniqueGame(response) {
    const content = contentOf(response);
    const list = Array.isArray(content) ? content : [];
    if (list.length !== 1) return null;
    const item = list[0];
    const id = item?.id ?? item?.gameId;
    if (id === void 0 || id === null) return null;
    return {
      appId: item?.appId === void 0 || item?.appId === null ? "" : String(item.appId),
      gameId: String(id),
      gameName: String(item?.gameName ?? item?.name ?? "")
    };
  }
  async function preflightBatch(rows, {
    client,
    region = "cn",
    fetchKeySaleList = client?.fetchKeySaleList
  } = {}) {
    if (!client?.fetchSaleKeyByUrl || !client?.fetchSaleKeyByName || !fetchKeySaleList) {
      throw new TypeError("preflightBatch 需要 fetchSaleKeyByUrl、fetchSaleKeyByName 和 fetchKeySaleList");
    }
    const errors = [];
    const resolved = [];
    for (const row of rows) {
      try {
        let gameId = row.gameId || "";
        let matchedGame = null;
        if (row.appId) {
          matchedGame = uniqueGame(await client.fetchSaleKeyByUrl(`${STEAM_APP_URL}${row.appId}/`, region));
          if (!matchedGame) throw new Error("appId 未唯一解析到 SteamPy 商品");
          if (gameId && gameId !== matchedGame.gameId) {
            throw new Error(`appId 解析到 gameId=${matchedGame.gameId}，与显式 gameId=${gameId} 冲突`);
          }
          gameId ||= matchedGame.gameId;
        }
        if (!gameId) {
          matchedGame = uniqueGame(await client.fetchSaleKeyByName(row.gameName, region));
          if (!matchedGame) throw new Error("gameName 未唯一解析到 SteamPy 商品");
          gameId = matchedGame.gameId;
        }
        resolved.push({
          ...row,
          appId: row.appId || matchedGame?.appId || "",
          gameId,
          resolvedGameName: matchedGame?.gameName || row.gameName
        });
      } catch (error) {
        errors.push(errorRecord(row, error?.message || String(error), null, "resolve"));
      }
    }
    const groups = /* @__PURE__ */ new Map();
    for (const row of resolved) {
      if (!groups.has(row.gameId)) {
        groups.set(row.gameId, {
          appId: row.appId,
          gameId: row.gameId,
          gameName: row.resolvedGameName || row.gameName,
          rows: [],
          keys: []
        });
      }
      const group = groups.get(row.gameId);
      group.rows.push(row);
      group.keys.push(row.key);
    }
    for (const group of groups.values()) {
      try {
        const response = await fetchKeySaleList({ gameId: group.gameId, region });
        const content = contentOf(response);
        const list = Array.isArray(content) ? content : [];
        if (!list.length) throw new Error("SteamPy 商品没有可用挂单价格");
        group.keyPrice = list[0]?.keyPrice;
        if (group.keyPrice === void 0 || group.keyPrice === null || group.keyPrice === "") throw new Error("SteamPy 商品最低挂单缺少 keyPrice");
      } catch (error) {
        for (const row of group.rows) errors.push(errorRecord(row, error?.message || String(error), null, "price"));
      }
    }
    return { rows: resolved, groups: [...groups.values()].filter((group) => group.keyPrice !== void 0), errors };
  }
  async function submitBatch(groups, {
    client,
    minimumIntervalMs = KEY_SALE_REQUEST_INTERVAL_MS,
    now = () => Date.now(),
    onSubmitting,
    onWaiting,
    region = "cn",
    shouldContinue = () => true,
    wait = waitFor
  } = {}) {
    if (!client?.startKeySale) throw new TypeError("submitBatch 需要 startKeySale");
    const results = [];
    let stopped = false;
    let pendingGroups = [];
    let lastRequestStartedAt = null;
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      if (!shouldContinue() || client.isTokenInvalid?.()) {
        stopped = true;
        pendingGroups = groups.slice(index);
        break;
      }
      if (lastRequestStartedAt !== null) {
        const waitMs = Math.max(0, lastRequestStartedAt + minimumIntervalMs - now());
        if (waitMs > 0) {
          onWaiting?.({ group, index, total: groups.length, waitMs });
          await wait(waitMs);
        }
        if (!shouldContinue() || client.isTokenInvalid?.()) {
          stopped = true;
          pendingGroups = groups.slice(index);
          break;
        }
      }
      onSubmitting?.({ group, index, total: groups.length });
      lastRequestStartedAt = now();
      try {
        const result = await client.startKeySale({
          region,
          gameId: group.gameId,
          keys: group.keys.join("\n"),
          sellPrice: group.keyPrice
        });
        results.push({ ok: true, gameId: group.gameId, rows: group.rows, rawLines: group.rows.map((row) => row.rawLine), result });
      } catch (error) {
        results.push({ ok: false, gameId: group.gameId, rows: group.rows, rawLines: group.rows.map((row) => row.rawLine), error, message: error?.message || String(error) });
        if (client.isTokenInvalid?.()) {
          stopped = true;
          pendingGroups = groups.slice(index + 1);
          break;
        }
      }
    }
    return { results, stopped, pendingGroups };
  }

  // src/lib/steampy/steampy-plus-seller.js
  var SELLER_PATH = "/pro/seller/sellerCDKey";
  var BATCH_BUTTON_ATTRIBUTE = "data-steampy-plus-batch-add";
  var BATCH_MODAL_ATTRIBUTE = "data-steampy-plus-batch-modal";
  var BATCH_STYLE_ATTRIBUTE = "data-steampy-plus-batch-style";
  var REGION_BY_LABEL = {
    国区: "cn",
    俄罗斯区: "ru",
    全球区: "us",
    土区: "tl"
  };
  function isSellerPage() {
    return location.pathname.replace(/\/+$/, "") === SELLER_PATH;
  }
  function createElement(tagName, options = {}) {
    const element = document.createElement(tagName);
    if (options.className) element.className = options.className;
    if (options.text !== void 0) element.textContent = options.text;
    if (options.type) element.type = options.type;
    if (options.disabled !== void 0) element.disabled = options.disabled;
    if (options.attributes) {
      Object.entries(options.attributes).forEach(([name, value]) => {
        element.setAttribute(name, value);
      });
    }
    return element;
  }
  function errorMessage(error) {
    return error?.message || String(error);
  }
  function rowLabel(row) {
    const locator = row.gameName || (row.appId ? `AppID ${row.appId}` : `gameId ${row.gameId}`);
    return `第 ${row.lineNumber} 行 · ${locator}`;
  }
  function collectFailedRows(results, groups, stoppedAt) {
    const rows = [];
    results.forEach((result) => {
      if (!result?.ok) rows.push(...result?.rows || []);
    });
    if (stoppedAt !== null) {
      groups.slice(stoppedAt).forEach((group) => rows.push(...group.rows));
    }
    return rows;
  }
  function createSteamPySellerController({
    client,
    parseBatchCsv: parseBatchCsv2,
    preflightBatch: preflightBatch2,
    submitBatch: submitBatch2
  } = {}) {
    let started = false;
    let observer = null;
    let injectionScheduled = false;
    let modal = null;
    let removeModalKeydown = null;
    let lifecycleGeneration = 0;
    let preservedDraft = "";
    let submissionActive = false;
    function currentRegionSnapshot() {
      const activeRegion = document.querySelector(".area-wap > .qu-li-a");
      const label = activeRegion?.textContent.trim() || "";
      const region = REGION_BY_LABEL[label];
      if (!region) throw new Error("无法识别当前出售区域，请刷新页面后重试");
      return { label, region };
    }
    function assertRegionSnapshot(snapshot) {
      const current = currentRegionSnapshot();
      if (current.region !== snapshot.region || current.label !== snapshot.label) {
        throw new Error(`出售区域已从“${snapshot.label}”切换为“${current.label}”，请重新预检`);
      }
    }
    function ensureStyle() {
      if (document.querySelector(`[${BATCH_STYLE_ATTRIBUTE}]`)) return;
      const style = createElement("style", {
        attributes: { [BATCH_STYLE_ATTRIBUTE]: "true" }
      });
      style.textContent = `
      [${BATCH_MODAL_ATTRIBUTE}] {
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(0, 0, 0, 0.55);
        box-sizing: border-box;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-dialog {
        width: min(920px, 100%);
        max-height: min(840px, calc(100vh - 48px));
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 22px;
        overflow: auto;
        border-radius: 10px;
        background: #fff;
        color: #1f2329;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-header,
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-actions,
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-confirm {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-header {
        justify-content: space-between;
      }
      [${BATCH_MODAL_ATTRIBUTE}] h2,
      [${BATCH_MODAL_ATTRIBUTE}] p {
        margin: 0;
      }
      [${BATCH_MODAL_ATTRIBUTE}] textarea {
        min-height: 210px;
        padding: 10px;
        resize: vertical;
        border: 1px solid #c9cdd4;
        border-radius: 6px;
        font: 13px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace;
      }
      [${BATCH_MODAL_ATTRIBUTE}] button {
        min-height: 34px;
        padding: 0 16px;
        border: 1px solid #c9cdd4;
        border-radius: 5px;
        background: #fff;
        cursor: pointer;
      }
      [${BATCH_MODAL_ATTRIBUTE}] button.sp-batch-primary {
        border-color: #165dff;
        background: #165dff;
        color: #fff;
      }
      [${BATCH_MODAL_ATTRIBUTE}] button:disabled,
      [${BATCH_MODAL_ATTRIBUTE}] textarea:disabled {
        cursor: not-allowed;
        opacity: 0.6;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-close {
        min-width: 34px;
        padding: 0;
        font-size: 22px;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-panel {
        display: none;
        padding: 12px;
        border-radius: 6px;
        background: #f2f3f5;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-panel[data-visible="true"] {
        display: block;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-list {
        display: grid;
        gap: 8px;
        margin: 10px 0 0;
        padding: 0;
        list-style: none;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-error {
        color: #cb2634;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-success {
        color: #168344;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-progress {
        font-weight: 600;
      }
    `;
      document.head.append(style);
    }
    function closeModal() {
      if (!modal || modal.running) return;
      removeModalKeydown?.();
      removeModalKeydown = null;
      modal.root.remove();
      modal = null;
    }
    function setSubmissionActive(active) {
      submissionActive = active;
      const batchButton = document.querySelector(`[${BATCH_BUTTON_ATTRIBUTE}]`);
      if (batchButton) {
        batchButton.disabled = active;
        batchButton.textContent = active ? "批量上架处理中" : "批量添加CDKey";
      }
    }
    function openModal() {
      if (modal || submissionActive || !isSellerPage()) return;
      ensureStyle();
      const root = createElement("div", {
        attributes: {
          [BATCH_MODAL_ATTRIBUTE]: "true",
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "steampy-plus-batch-title"
        }
      });
      const dialog = createElement("section", { className: "sp-batch-dialog" });
      const header = createElement("div", { className: "sp-batch-header" });
      const title = createElement("h2", {
        text: "批量添加 CDKey",
        attributes: { id: "steampy-plus-batch-title" }
      });
      const closeButton = createElement("button", {
        className: "sp-batch-close",
        text: "×",
        type: "button",
        attributes: { "aria-label": "关闭批量添加窗口" }
      });
      header.append(title, closeButton);
      const format = createElement("p", {
        text: "固定无表头 CSV：gameName,key,appId,gameId。每行 2–4 列；至少填写 gameName、appId、gameId 之一，ID 始终按文本处理。"
      });
      const textarea = createElement("textarea", {
        attributes: {
          placeholder: '示例：\n"Chillquarium","AAAAA-BBBBB-CCCCC","2276930",',
          "aria-label": "批量 CDKey CSV"
        }
      });
      const status = createElement("p", {
        text: "请先预检；预检不会提交 CDKey。",
        attributes: { "aria-live": "polite" }
      });
      const errorPanel = createElement("section", {
        className: "sp-batch-panel sp-batch-error",
        attributes: { "data-visible": "false" }
      });
      const previewPanel = createElement("section", {
        className: "sp-batch-panel",
        attributes: { "data-visible": "false" }
      });
      const progressPanel = createElement("section", {
        className: "sp-batch-panel",
        attributes: { "data-visible": "false", "aria-live": "polite" }
      });
      const confirmLabel = createElement("label", { className: "sp-batch-confirm" });
      const confirmCheckbox = createElement("input", { type: "checkbox", disabled: true });
      const confirmText = createElement("span", { text: "我已核对预览内容和出售区域，并确认开始真实上架。" });
      confirmLabel.append(confirmCheckbox, confirmText);
      const actions = createElement("div", { className: "sp-batch-actions" });
      const preflightButton = createElement("button", {
        className: "sp-batch-primary",
        text: "预检",
        type: "button"
      });
      const submitButton = createElement("button", {
        className: "sp-batch-primary",
        text: "确认并串行上架",
        type: "button",
        disabled: true
      });
      const refreshButton = createElement("button", {
        text: "刷新页面",
        type: "button",
        disabled: true
      });
      const cancelButton = createElement("button", { text: "关闭", type: "button" });
      actions.append(preflightButton, submitButton, refreshButton, cancelButton);
      dialog.append(
        header,
        format,
        textarea,
        status,
        errorPanel,
        previewPanel,
        progressPanel,
        confirmLabel,
        actions
      );
      root.append(dialog);
      document.body.append(root);
      const state = {
        confirmCheckbox,
        preflightResult: null,
        regionSnapshot: null,
        root,
        running: false,
        textarea
      };
      modal = state;
      if (preservedDraft) {
        textarea.value = preservedDraft;
        status.textContent = "已恢复上次离开页面时尚未完成的输入，请重新预检。";
        preservedDraft = "";
      }
      function clearPanel(panel) {
        panel.replaceChildren();
        panel.dataset.visible = "false";
      }
      function renderErrors(errors) {
        clearPanel(errorPanel);
        if (!errors.length) return;
        errorPanel.dataset.visible = "true";
        errorPanel.append(createElement("strong", { text: `发现 ${errors.length} 个问题` }));
        const list = createElement("ul", { className: "sp-batch-list" });
        errors.forEach((error) => {
          const prefix = error.lineNumber ? `第 ${error.lineNumber} 行：` : "";
          list.append(createElement("li", { text: `${prefix}${error.message || errorMessage(error)}` }));
        });
        errorPanel.append(list);
      }
      function renderPreview(result, snapshot) {
        clearPanel(previewPanel);
        previewPanel.dataset.visible = "true";
        previewPanel.append(
          createElement("strong", {
            text: `出售区域：${snapshot.label}；共 ${result.rows.length} 行、${result.groups.length} 个商品`
          })
        );
        const list = createElement("ul", { className: "sp-batch-list" });
        result.groups.forEach((group) => {
          const name = group.gameName || (group.appId ? `AppID ${group.appId}` : "未命名商品");
          const appIdText = group.appId ? ` · AppID ${group.appId}` : "";
          list.append(
            createElement("li", {
              text: `${name}${appIdText} · gameId ${group.gameId} · ${group.rows.length} 个 Key · 挂单价 ${group.keyPrice}`
            })
          );
        });
        previewPanel.append(list);
      }
      function resetPreflight() {
        state.preflightResult = null;
        state.regionSnapshot = null;
        confirmCheckbox.checked = false;
        confirmCheckbox.disabled = true;
        submitButton.disabled = true;
        refreshButton.disabled = true;
        clearPanel(errorPanel);
        clearPanel(previewPanel);
        clearPanel(progressPanel);
        status.className = "";
        status.textContent = "内容已改变，请重新预检。";
      }
      function setRunning(running) {
        state.running = running;
        textarea.disabled = running;
        preflightButton.disabled = running;
        confirmCheckbox.disabled = running || !state.preflightResult;
        submitButton.disabled = running || !confirmCheckbox.checked || !state.preflightResult;
        closeButton.disabled = running;
        cancelButton.disabled = running;
      }
      async function runPreflight() {
        if (typeof parseBatchCsv2 !== "function" || typeof preflightBatch2 !== "function" || !client) {
          renderErrors([{ message: "批量功能依赖未完成接线，请刷新脚本后重试" }]);
          return;
        }
        let snapshot;
        let parsed;
        try {
          snapshot = currentRegionSnapshot();
          parsed = parseBatchCsv2(textarea.value);
        } catch (error) {
          renderErrors([{ message: errorMessage(error) }]);
          status.textContent = "输入或区域读取失败，不会提交任何 CDKey。";
          return;
        }
        renderErrors(parsed.errors || []);
        if (!parsed.rows?.length || parsed.errors?.length) {
          status.textContent = parsed.rows?.length ? "请修正输入问题后重新预检。" : "没有可预检的有效行。";
          return;
        }
        setRunning(true);
        status.textContent = `正在预检 ${parsed.rows.length} 行，当前区域：${snapshot.label}…`;
        try {
          const result = await preflightBatch2(parsed.rows, { client, region: snapshot.region });
          assertRegionSnapshot(snapshot);
          renderErrors(result.errors || []);
          renderPreview(result, snapshot);
          if (result.errors?.length || !result.groups?.length) {
            status.textContent = "预检未通过，不会启用提交。";
            return;
          }
          state.preflightResult = result;
          state.regionSnapshot = snapshot;
          confirmCheckbox.disabled = false;
          status.className = "sp-batch-success";
          status.textContent = "预检通过。请核对区域、商品、Key 数量和挂单价后勾选确认。";
        } catch (error) {
          renderErrors([{ message: errorMessage(error) }]);
          status.textContent = "预检失败，不会提交任何 CDKey。";
        } finally {
          setRunning(false);
        }
      }
      async function runSubmission() {
        if (!state.preflightResult || typeof submitBatch2 !== "function") return;
        try {
          assertRegionSnapshot(state.regionSnapshot);
        } catch (error) {
          resetPreflight();
          renderErrors([{ message: errorMessage(error) }]);
          return;
        }
        const submissionGeneration = lifecycleGeneration;
        const { groups } = state.preflightResult;
        let allResults = [];
        let stoppedAt = null;
        setSubmissionActive(true);
        setRunning(true);
        progressPanel.dataset.visible = "true";
        status.className = "";
        status.textContent = `开始在“${state.regionSnapshot.label}”串行上架，运行期间不可编辑或关闭。`;
        let batchResult;
        try {
          batchResult = await submitBatch2(groups, {
            client,
            region: state.regionSnapshot.region,
            shouldContinue: () => submissionGeneration === lifecycleGeneration && started && isSellerPage(),
            onWaiting: ({ index, total, waitMs }) => {
              progressPanel.replaceChildren(
                createElement("p", {
                  className: "sp-batch-progress",
                  text: `已处理 ${index}/${total} 组，等待 ${Math.ceil(waitMs / 1e3)} 秒后提交下一组`
                })
              );
            },
            onSubmitting: ({ group, index, total }) => {
              progressPanel.replaceChildren(
                createElement("p", {
                  className: "sp-batch-progress",
                  text: `正在提交 ${index + 1}/${total}：gameId ${group.gameId}，${group.rows.length} 个 Key`
                })
              );
            }
          });
        } catch (error) {
          batchResult = {
            results: [],
            stopped: true,
            pendingGroups: groups
          };
          console.error("[SteamPy Plus] 批量上架队列异常", error);
        }
        allResults = batchResult.results || [];
        if (batchResult.stopped) {
          stoppedAt = groups.length - (batchResult.pendingGroups?.length || 0);
        }
        const failedRows = collectFailedRows(allResults, groups, stoppedAt);
        const failedInput = failedRows.map((row) => row.rawLine).filter(Boolean).join("\n");
        if (submissionGeneration !== lifecycleGeneration || !started || !isSellerPage()) {
          preservedDraft = failedInput;
          state.running = false;
          setSubmissionActive(false);
          return;
        }
        const succeeded = allResults.filter((result) => result.ok).length;
        const failed = allResults.filter((result) => !result.ok).length + (stoppedAt === null ? 0 : groups.length - stoppedAt);
        textarea.value = failedInput;
        progressPanel.replaceChildren(
          createElement("p", {
            className: failedRows.length ? "sp-batch-error" : "sp-batch-success",
            text: `完成：成功 ${succeeded} 组，失败或未执行 ${failed} 组${stoppedAt === null ? "" : "，队列已提前停止"}。`
          })
        );
        if (failedRows.length) {
          const list = createElement("ul", { className: "sp-batch-list sp-batch-error" });
          allResults.filter((result) => !result.ok).forEach((result) => {
            const affected = (result.rows || []).map(rowLabel).join("、");
            list.append(createElement("li", { text: `${affected}：${result.message || errorMessage(result.error)}` }));
          });
          progressPanel.append(list);
          status.textContent = "失败和未执行的原始行已保留在输入框，可刷新数据后重新预检。";
        } else {
          status.className = "sp-batch-success";
          status.textContent = "全部提交完成。请刷新页面查看最新挂单列表。";
        }
        state.preflightResult = null;
        state.regionSnapshot = null;
        confirmCheckbox.checked = false;
        submitButton.disabled = true;
        refreshButton.disabled = false;
        setRunning(false);
        setSubmissionActive(false);
      }
      textarea.addEventListener("input", resetPreflight);
      preflightButton.addEventListener("click", runPreflight);
      confirmCheckbox.addEventListener("change", () => {
        submitButton.disabled = !confirmCheckbox.checked || !state.preflightResult;
      });
      submitButton.addEventListener("click", runSubmission);
      refreshButton.addEventListener("click", () => location.reload());
      closeButton.addEventListener("click", closeModal);
      cancelButton.addEventListener("click", closeModal);
      root.addEventListener("click", (event) => {
        if (event.target === root) closeModal();
      });
      const onKeydown = (event) => {
        if (event.key === "Escape") closeModal();
      };
      document.addEventListener("keydown", onKeydown);
      removeModalKeydown = () => document.removeEventListener("keydown", onKeydown);
      textarea.focus();
    }
    function injectButton() {
      injectionScheduled = false;
      if (!started || !isSellerPage()) return;
      const actionBar = document.querySelector(".cdkTrade-layout > .w100.tc");
      if (!actionBar || actionBar.querySelector(`[${BATCH_BUTTON_ATTRIBUTE}]`)) return;
      const addButton = [...actionBar.querySelectorAll(":scope > button")].find((button) => button.textContent.trim() === "添加CDKey");
      if (!addButton) return;
      const batchButton = createElement("button", {
        className: addButton.className,
        text: submissionActive ? "批量上架处理中" : "批量添加CDKey",
        type: "button",
        disabled: submissionActive,
        attributes: { [BATCH_BUTTON_ATTRIBUTE]: "true" }
      });
      batchButton.addEventListener("click", openModal);
      addButton.insertAdjacentElement("afterend", batchButton);
    }
    function scheduleInjection() {
      if (injectionScheduled) return;
      injectionScheduled = true;
      queueMicrotask(injectButton);
    }
    function start() {
      if (started) return;
      started = true;
      observer = new MutationObserver(scheduleInjection);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      scheduleInjection();
    }
    function cleanup() {
      started = false;
      lifecycleGeneration += 1;
      injectionScheduled = false;
      observer?.disconnect();
      observer = null;
      document.querySelectorAll(`[${BATCH_BUTTON_ATTRIBUTE}]`).forEach((button) => button.remove());
      if (modal) {
        preservedDraft = modal.textarea.value;
        modal.running = false;
        closeModal();
      }
      document.querySelector(`[${BATCH_STYLE_ATTRIBUTE}]`)?.remove();
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
  function errorMessage2(error) {
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
        notify(`同步Steam数据失败：${errorMessage2(error)}`);
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
      const stateLabel = isFamilyEnabled() ? "已开启（点击关闭）" : "已关闭（点击开启）";
      GM_registerMenuCommand(
        `家庭库游戏视为已拥有：${stateLabel}`,
        toggleFamilyLibrary,
        { id: FAMILY_LIBRARY_MENU_ID }
      );
    }
    function registerIgnoredGamesMenu() {
      const stateLabel = isIgnoredGamesEnabled() ? "已开启（点击关闭）" : "已关闭（点击开启）";
      GM_registerMenuCommand(
        `隐藏 Steam 已忽略游戏：${stateLabel}`,
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

  // src/lib/userscript/gm-xhr.js
  function createGmXhrError(message, response) {
    const error = new Error(message);
    error.response = response;
    return error;
  }
  function gmXhr(options, sendRequest = GM_xmlhttpRequest) {
    return new Promise((resolve, reject) => {
      sendRequest({
        timeout: 2e4,
        ...options,
        onload: resolve,
        onerror: (response) => reject(createGmXhrError("网络请求失败", response)),
        ontimeout: (response) => reject(createGmXhrError("网络请求超时", response))
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

  // src/lib/steampy/steampy-plus.js
  var LEGACY_BUYER_PATH = "/cdKey/cdKey";
  var PRO_BUYER_PATH = "/pro/cdKey/cdKey";
  var SELLER_PATH2 = "/pro/seller/sellerCDKey";
  var DETAIL_PATH = "/cdkDetail";
  function startSteamPyPlus({ ajaxHooker: ajaxHooker2, elmGetter: elmGetter2, jQuery }) {
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
    const xbootClient = createSteampyXbootClient({ getAccessToken: readSteampyLocalToken });
    const advancedFilter = createSteamPyAdvancedFilterController({
      fetchFilterMetadata: xbootClient.fetchFilterMetadata,
      fetchSteamAppList: xbootClient.fetchSteamAppList,
      fetchSteamGameByAppId: xbootClient.fetchSteamGameByAppId,
      setHideDlcSuspended: filter.setHideDlcSuspended
    });
    buyer = createSteamPyBuyerController({ advancedFilter, elmGetter: elmGetter2, jQuery, filter, rating });
    const seller = createSteamPySellerController({
      client: xbootClient,
      parseBatchCsv,
      preflightBatch,
      submitBatch
    });
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
      if (pathname.startsWith(SELLER_PATH2) && !sellerActive) {
        seller.start();
        sellerActive = true;
      } else if (!pathname.startsWith(SELLER_PATH2) && sellerActive) {
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
  startSteamPyPlus({ ajaxHooker, elmGetter, jQuery: $ });
})();
