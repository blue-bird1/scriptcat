// ==UserScript==
// @name         Steam Discovery Queue Auto Next
// @name:zh-CN   Steam 探索队列自动下一项
// @namespace    https://github.com/blue-bird1/scriptcat
// @version      0.3.6
// @description  自动筛选 Steam 探索队列，并在愿望单成功或点击忽略后进入下一项
// @author       blue-bird1
// @match        https://store.steampowered.com/*
// @grant        none
// @run-at       document-start
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/blue-bird1/scriptcat/main/steam-discovery-queue.user.js
// @updateURL    https://raw.githubusercontent.com/blue-bird1/scriptcat/main/steam-discovery-queue.user.js
// ==/UserScript==

(() => {
  // src/lib/steam/discovery-queue-config.js
  var STORAGE_KEY = "scriptcat:steam-discovery-queue:config:v1";
  var BUTTON_ID = "scriptcat-steam-discovery-queue-config-button";
  var POPUP_ID = "scriptcat-steam-discovery-queue-config-popup";
  var STYLE_ID = "scriptcat-steam-discovery-queue-config-style";
  var DEFAULT_DISCOVERY_QUEUE_CONFIG = {
    version: 1,
    enabled: false,
    minimumPositiveRate: { enabled: false, value: 70 },
    minimumReviewCount: { enabled: false, value: 100 },
    maximumPrice: { enabled: false, value: 100 },
    minimumDiscount: { enabled: false, value: 0 },
    earliestReleaseDate: { enabled: false, value: "2015-01-01" },
    ignoreFree: false,
    ignoreUnreviewed: false,
    excludedTags: { enabled: false, value: [] }
  };
  function cloneDefaultConfig() {
    return {
      ...DEFAULT_DISCOVERY_QUEUE_CONFIG,
      minimumPositiveRate: { ...DEFAULT_DISCOVERY_QUEUE_CONFIG.minimumPositiveRate },
      minimumReviewCount: { ...DEFAULT_DISCOVERY_QUEUE_CONFIG.minimumReviewCount },
      maximumPrice: { ...DEFAULT_DISCOVERY_QUEUE_CONFIG.maximumPrice },
      minimumDiscount: { ...DEFAULT_DISCOVERY_QUEUE_CONFIG.minimumDiscount },
      earliestReleaseDate: { ...DEFAULT_DISCOVERY_QUEUE_CONFIG.earliestReleaseDate },
      excludedTags: { ...DEFAULT_DISCOVERY_QUEUE_CONFIG.excludedTags, value: [] }
    };
  }
  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function normalizeBoolean(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }
  function normalizeNumber(value, fallback, maximum = Infinity) {
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(maximum, Math.max(0, number));
  }
  function normalizeDate(value, fallback) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return fallback;
    }
    const date = /* @__PURE__ */ new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? fallback : value;
  }
  function normalizeTags(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const tags = [];
    const seen = /* @__PURE__ */ new Set();
    for (const tag of value) {
      if (typeof tag !== "string") {
        continue;
      }
      const normalized = tag.trim();
      const key = normalized.toLocaleLowerCase();
      if (normalized && !seen.has(key)) {
        seen.add(key);
        tags.push(normalized);
      }
    }
    return tags;
  }
  function normalizeRule(value, fallback, maximum) {
    if (!isRecord(value)) {
      return { ...fallback };
    }
    return {
      enabled: normalizeBoolean(value.enabled, fallback.enabled),
      value: normalizeNumber(value.value, fallback.value, maximum)
    };
  }
  function normalizeConfig(value) {
    if (!isRecord(value) || value.version !== 1) {
      return cloneDefaultConfig();
    }
    const fallback = DEFAULT_DISCOVERY_QUEUE_CONFIG;
    const tags = isRecord(value.excludedTags) ? value.excludedTags : fallback.excludedTags;
    return {
      version: 1,
      enabled: normalizeBoolean(value.enabled, fallback.enabled),
      minimumPositiveRate: normalizeRule(value.minimumPositiveRate, fallback.minimumPositiveRate, 100),
      minimumReviewCount: normalizeRule(value.minimumReviewCount, fallback.minimumReviewCount),
      maximumPrice: normalizeRule(value.maximumPrice, fallback.maximumPrice),
      minimumDiscount: normalizeRule(value.minimumDiscount, fallback.minimumDiscount, 100),
      earliestReleaseDate: {
        enabled: normalizeBoolean(value.earliestReleaseDate?.enabled, fallback.earliestReleaseDate.enabled),
        value: normalizeDate(value.earliestReleaseDate?.value, fallback.earliestReleaseDate.value)
      },
      ignoreFree: normalizeBoolean(value.ignoreFree, fallback.ignoreFree),
      ignoreUnreviewed: normalizeBoolean(value.ignoreUnreviewed, fallback.ignoreUnreviewed),
      excludedTags: {
        enabled: normalizeBoolean(tags.enabled, fallback.excludedTags.enabled),
        value: normalizeTags(tags.value)
      }
    };
  }
  function loadDiscoveryQueueConfig() {
    try {
      const serialized = localStorage.getItem(STORAGE_KEY);
      return serialized === null ? cloneDefaultConfig() : normalizeConfig(JSON.parse(serialized));
    } catch {
      return cloneDefaultConfig();
    }
  }
  function saveDiscoveryQueueConfig(value) {
    const config = normalizeConfig(value);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      return config;
    }
    return config;
  }
  function appendText(element, text) {
    element.textContent = text;
    return element;
  }
  function createElement(tagName, className) {
    const element = document.createElement(tagName);
    if (className) {
      element.className = className;
    }
    return element;
  }
  function createSteamButton(text, className) {
    const button = createElement("button", className);
    button.type = "button";
    button.append(appendText(createElement("span"), text));
    return button;
  }
  function addCheckbox(parent, label, checked) {
    const labelElement = createElement("label", "scriptcat-discovery-queue-config-option");
    const input = createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    labelElement.append(input, document.createTextNode(label));
    parent.append(labelElement);
    return input;
  }
  function addRule(parent, label, config, inputType, attributes = {}) {
    const row = createElement("div", "scriptcat-discovery-queue-config-rule");
    const enabled = addCheckbox(row, label, config.enabled);
    const input = createElement("input");
    input.type = inputType;
    input.value = config.value;
    Object.assign(input, attributes);
    row.append(input);
    parent.append(row);
    return { enabled, input };
  }
  function injectStyles() {
    let style = document.getElementById(STYLE_ID);
    if (style) {
      return style;
    }
    style = createElement("style");
    style.id = STYLE_ID;
    style.textContent = `#${BUTTON_ID}{margin-left:auto}.scriptcat-discovery-queue-config-backdrop{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72)}.scriptcat-discovery-queue-config-popup{box-sizing:border-box;width:min(680px,calc(100vw - 32px));max-height:calc(100vh - 32px);padding:24px;overflow:auto;border:1px solid #000;background:linear-gradient(135deg,#1b2838 0%,#2a475e 100%);box-shadow:0 0 24px #000}.scriptcat-discovery-queue-config-popup h2{margin-top:0;color:#fff}.scriptcat-discovery-queue-config-fields{display:grid;gap:12px;margin:20px 0}.scriptcat-discovery-queue-config-rule{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.scriptcat-discovery-queue-config-rule>input{min-width:140px}.scriptcat-discovery-queue-config-option{display:flex;align-items:center;gap:6px}.scriptcat-discovery-queue-config-tags{display:flex;gap:6px;align-items:center;flex:1;flex-wrap:wrap}.scriptcat-discovery-queue-config-chip{display:inline-flex;gap:4px;align-items:center;padding:3px 6px;background:#16202d}.scriptcat-discovery-queue-config-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}`;
    document.head.append(style);
    return style;
  }
  function readNumber(input) {
    return input.value === "" ? Number.NaN : Number(input.value);
  }
  function createDiscoveryQueueConfigUi({ onSave, onOpenChange } = {}) {
    let config = loadDiscoveryQueueConfig();
    let button;
    let popup;
    let backdrop;
    let tags = [];
    let removeKeydown = () => {
    };
    let removeButtonClick = () => {
    };
    function notifyOpenChange(isOpen) {
      if (typeof onOpenChange === "function") {
        onOpenChange(isOpen);
      }
    }
    function closePopup() {
      if (!popup) {
        return;
      }
      removeKeydown();
      removeKeydown = () => {
      };
      popup.remove();
      backdrop.remove();
      popup = void 0;
      backdrop = void 0;
      notifyOpenChange(false);
    }
    function syncDisconnectedPopup() {
      if (popup && !popup.isConnected) {
        closePopup();
      }
    }
    function openPopup() {
      syncDisconnectedPopup();
      if (popup) {
        return;
      }
      injectStyles();
      const draft = normalizeConfig(config);
      tags = [...draft.excludedTags.value];
      backdrop = createElement("div", "scriptcat-discovery-queue-config-backdrop");
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) {
          closePopup();
        }
      });
      popup = createElement(
        "section",
        "popup_block_new popup_body popup_menu scriptcat-discovery-queue-config-popup"
      );
      popup.id = POPUP_ID;
      popup.setAttribute("role", "dialog");
      popup.setAttribute("aria-modal", "true");
      popup.setAttribute("aria-label", "自动筛选设置");
      const title = appendText(createElement("h2"), "自动筛选设置");
      const description = appendText(
        createElement("p"),
        "多个已启用规则之间按 OR 匹配；评分、评论数、价格、折扣或发布日期缺失的项目不会自动处理。"
      );
      const fields = createElement("div", "scriptcat-discovery-queue-config-fields");
      const enabled = addCheckbox(fields, "启用自动筛选", draft.enabled);
      const positiveRate = addRule(fields, "最低好评率 (%)", draft.minimumPositiveRate, "number", { min: 0, max: 100, step: "any" });
      const reviewCount = addRule(fields, "最低评论数", draft.minimumReviewCount, "number", { min: 0, step: "any" });
      const maximumPrice = addRule(fields, "最高价格", draft.maximumPrice, "number", { min: 0, step: "any" });
      const minimumDiscount = addRule(fields, "最低折扣 (%)", draft.minimumDiscount, "number", { min: 0, max: 100, step: "any" });
      const releaseDate = addRule(fields, "最早发布日期", draft.earliestReleaseDate, "date");
      const ignoreFree = addCheckbox(fields, "忽略免费游戏", draft.ignoreFree);
      const ignoreUnreviewed = addCheckbox(fields, "忽略未评测游戏", draft.ignoreUnreviewed);
      const tagRow = createElement("div", "scriptcat-discovery-queue-config-rule");
      const tagEnabled = addCheckbox(tagRow, "排除标签", draft.excludedTags.enabled);
      const tagContainer = createElement("div", "scriptcat-discovery-queue-config-tags");
      const tagInput = createElement("input");
      tagInput.type = "text";
      tagInput.placeholder = "输入标签后按回车或逗号";
      tagContainer.append(tagInput);
      tagRow.append(tagContainer);
      fields.append(tagRow);
      const actions = createElement("div", "scriptcat-discovery-queue-config-actions");
      const reset = createSteamButton("恢复默认", "btnv6_grey_black btn_medium");
      const cancel = createSteamButton("取消", "btnv6_blue_hoverfade btn_medium");
      const save = createSteamButton("保存", "btnv6_green_white_innerfade btn_medium");
      actions.append(reset, cancel, save);
      popup.append(title, description, fields, actions);
      backdrop.append(popup);
      const popupHost = button?.closest('[role="dialog"]') ?? document.body;
      popupHost.append(backdrop);
      function renderTags() {
        for (const chip of [...tagContainer.children]) {
          if (chip !== tagInput) {
            chip.remove();
          }
        }
        for (const tag of tags) {
          const chip = createElement("span", "scriptcat-discovery-queue-config-chip");
          chip.append(document.createTextNode(tag));
          const remove = appendText(createElement("button"), "×");
          remove.type = "button";
          remove.setAttribute("aria-label", `移除标签 ${tag}`);
          remove.addEventListener("click", () => {
            tags = tags.filter((candidate) => candidate !== tag);
            renderTags();
          });
          chip.append(remove);
          tagContainer.insertBefore(chip, tagInput);
        }
      }
      function addTags(rawValue) {
        const candidates = rawValue.split(",").map((tag) => tag.trim()).filter(Boolean);
        tags = normalizeTags([...tags, ...candidates]);
        tagInput.value = "";
        renderTags();
      }
      tagInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === ",") {
          event.preventDefault();
          addTags(tagInput.value);
        }
      });
      tagInput.addEventListener("blur", () => addTags(tagInput.value));
      reset.addEventListener("click", () => {
        const defaults = cloneDefaultConfig();
        enabled.checked = defaults.enabled;
        positiveRate.enabled.checked = defaults.minimumPositiveRate.enabled;
        positiveRate.input.value = defaults.minimumPositiveRate.value;
        reviewCount.enabled.checked = defaults.minimumReviewCount.enabled;
        reviewCount.input.value = defaults.minimumReviewCount.value;
        maximumPrice.enabled.checked = defaults.maximumPrice.enabled;
        maximumPrice.input.value = defaults.maximumPrice.value;
        minimumDiscount.enabled.checked = defaults.minimumDiscount.enabled;
        minimumDiscount.input.value = defaults.minimumDiscount.value;
        releaseDate.enabled.checked = defaults.earliestReleaseDate.enabled;
        releaseDate.input.value = defaults.earliestReleaseDate.value;
        ignoreFree.checked = defaults.ignoreFree;
        ignoreUnreviewed.checked = defaults.ignoreUnreviewed;
        tagEnabled.checked = defaults.excludedTags.enabled;
        tags = [];
        renderTags();
      });
      cancel.addEventListener("click", closePopup);
      save.addEventListener("click", () => {
        config = saveDiscoveryQueueConfig({
          version: 1,
          enabled: enabled.checked,
          minimumPositiveRate: { enabled: positiveRate.enabled.checked, value: readNumber(positiveRate.input) },
          minimumReviewCount: { enabled: reviewCount.enabled.checked, value: readNumber(reviewCount.input) },
          maximumPrice: { enabled: maximumPrice.enabled.checked, value: readNumber(maximumPrice.input) },
          minimumDiscount: { enabled: minimumDiscount.enabled.checked, value: readNumber(minimumDiscount.input) },
          earliestReleaseDate: { enabled: releaseDate.enabled.checked, value: releaseDate.input.value },
          ignoreFree: ignoreFree.checked,
          ignoreUnreviewed: ignoreUnreviewed.checked,
          excludedTags: { enabled: tagEnabled.checked, value: tags }
        });
        closePopup();
        if (typeof onSave === "function") {
          onSave(config);
        }
      });
      function handleKeydown(event) {
        if (event.key === "Escape") {
          closePopup();
        }
      }
      document.addEventListener("keydown", handleKeydown);
      removeKeydown = () => document.removeEventListener("keydown", handleKeydown);
      renderTags();
      notifyOpenChange(true);
    }
    function ensureButton(container) {
      syncDisconnectedPopup();
      if (!(container instanceof Element)) {
        return void 0;
      }
      const existing = document.getElementById(BUTTON_ID);
      if (existing instanceof HTMLButtonElement) {
        button = existing;
      } else if (!button) {
        button = createSteamButton("自动筛选设置", "btnv6_blue_hoverfade btn_medium");
        button.id = BUTTON_ID;
        button.type = "button";
        const handleButtonClick = () => openPopup();
        button.addEventListener("click", handleButtonClick);
        removeButtonClick = () => button?.removeEventListener("click", handleButtonClick);
      }
      if (button.parentElement !== container) {
        container.append(button);
      }
      return button;
    }
    return {
      ensureButton,
      isOpen: () => Boolean(popup),
      getConfig: () => normalizeConfig(config),
      destroy() {
        closePopup();
        removeButtonClick();
        button?.remove();
        document.getElementById(STYLE_ID)?.remove();
        button = void 0;
      }
    };
  }

  // src/lib/steam/discovery-queue-rules.js
  var MONTHS = /* @__PURE__ */ new Map([
    ["jan", 0],
    ["feb", 1],
    ["mar", 2],
    ["apr", 3],
    ["may", 4],
    ["jun", 5],
    ["jul", 6],
    ["aug", 7],
    ["sep", 8],
    ["oct", 9],
    ["nov", 10],
    ["dec", 11]
  ]);
  function createEmptyData() {
    return {
      reviewCount: void 0,
      positiveRate: void 0,
      isFree: void 0,
      price: void 0,
      currency: void 0,
      discount: void 0,
      releaseDate: void 0
    };
  }
  function isNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }
  function parseEnglishDate(value) {
    if (typeof value !== "string") {
      return void 0;
    }
    const match = value.trim().match(/^(?:(?<month>[A-Za-z]+)\s+(?<day>\d{1,2})|(?<dayFirst>\d{1,2})\s+(?<monthFirst>[A-Za-z]+)),\s*(?<year>\d{4})$/);
    if (!match?.groups) {
      return void 0;
    }
    const monthName = (match.groups.month ?? match.groups.monthFirst).slice(0, 3).toLowerCase();
    const month = MONTHS.get(monthName);
    const day = Number(match.groups.day ?? match.groups.dayFirst);
    const year = Number(match.groups.year);
    const date = new Date(Date.UTC(year, month ?? -1, day));
    if (month === void 0 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
      return void 0;
    }
    return `${year.toString().padStart(4, "0")}-${(month + 1).toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  }
  function parseReviews(payload) {
    const summary = payload?.query_summary;
    if (!isNonNegativeInteger(summary?.total_positive) || !isNonNegativeInteger(summary?.total_negative) || !isNonNegativeInteger(summary?.total_reviews)) {
      return {};
    }
    return {
      reviewCount: summary.total_reviews,
      positiveRate: summary.total_reviews === 0 ? void 0 : summary.total_positive / summary.total_reviews * 100
    };
  }
  function parseDetails(payload, appId) {
    const details = payload?.[appId];
    if (details?.success !== true || !details.data || typeof details.data !== "object") {
      return {};
    }
    const result = {};
    if (typeof details.data.is_free === "boolean") {
      result.isFree = details.data.is_free;
    }
    const priceOverview = details.data.price_overview;
    if (isNonNegativeInteger(priceOverview?.final) && typeof priceOverview.currency === "string" && priceOverview.currency.trim()) {
      try {
        const currency = priceOverview.currency.trim().toUpperCase();
        const formatter = new Intl.NumberFormat("en", { style: "currency", currency });
        const fractionDigits = formatter.resolvedOptions().maximumFractionDigits;
        result.price = priceOverview.final / 10 ** fractionDigits;
        result.currency = currency;
        if (isNonNegativeInteger(priceOverview.discount_percent)) {
          result.discount = priceOverview.discount_percent;
        }
      } catch {
        result.price = void 0;
      }
    }
    if (details.data.release_date?.coming_soon !== true) {
      result.releaseDate = parseEnglishDate(details.data.release_date?.date);
    }
    return result;
  }
  function parseStoreItemPrice(formattedPrice, priceInCents) {
    if (typeof formattedPrice !== "string" || !isNonNegativeInteger(priceInCents)) {
      return void 0;
    }
    const numericParts = formattedPrice.match(/\d[\d\s.,\u00A0\u202F]*/g);
    if (numericParts?.length !== 1) {
      return void 0;
    }
    const numericText = numericParts[0].trim();
    if (!numericText || /[.,\s\u00A0\u202F]$/.test(numericText)) {
      return void 0;
    }
    const digits = numericText.replace(/[^\d]/g, "");
    if (!digits) {
      return void 0;
    }
    const integerPrice = Number(digits);
    const candidatesInCents = Number.isSafeInteger(integerPrice) ? [integerPrice * 100] : [];
    const decimalMatch = numericText.match(/[.,](\d{1,2})$/);
    if (decimalMatch) {
      const fractionalDigits = decimalMatch[1].length;
      const integerDigits = numericText.slice(0, -fractionalDigits - 1).replace(/[^\d]/g, "");
      if (integerDigits) {
        const integerPart = Number(integerDigits);
        const fractionalPart = Number(decimalMatch[1]) * 10 ** (2 - fractionalDigits);
        if (Number.isSafeInteger(integerPart) && Number.isSafeInteger(fractionalPart)) {
          candidatesInCents.push(integerPart * 100 + fractionalPart);
        }
      }
    }
    return candidatesInCents.includes(priceInCents) ? priceInCents / 100 : void 0;
  }
  function parseStoreItem(storeItem, appId) {
    if (!storeItem || typeof storeItem !== "object" || storeItem.success !== 1 || String(storeItem.appId) !== appId) {
      return {};
    }
    const result = {};
    if (isNonNegativeInteger(storeItem.reviewCount)) {
      result.reviewCount = storeItem.reviewCount;
    }
    if (typeof storeItem.positiveRate === "number" && Number.isFinite(storeItem.positiveRate) && storeItem.positiveRate >= 0 && storeItem.positiveRate <= 100) {
      result.positiveRate = storeItem.positiveRate;
    }
    if (typeof storeItem.isFree === "boolean") {
      result.isFree = storeItem.isFree;
      if (storeItem.isFree) {
        result.price = 0;
      }
    }
    if (storeItem.comingSoon === false && Number.isSafeInteger(storeItem.releaseDateUnix) && storeItem.releaseDateUnix > 0) {
      const date = new Date(storeItem.releaseDateUnix * 1e3);
      if (!Number.isNaN(date.getTime())) {
        result.releaseDate = date.toISOString().slice(0, 10);
      }
    }
    if (Number.isInteger(storeItem.discount) && storeItem.discount >= 0 && storeItem.discount <= 100) {
      result.discount = storeItem.discount;
    }
    if (result.price === void 0) {
      const price = parseStoreItemPrice(storeItem.formattedFinalPrice, storeItem.finalPriceInCents);
      if (price !== void 0) {
        result.price = price;
      }
    }
    return result;
  }
  async function loadJson(url) {
    try {
      const response = await fetch(url);
      return response.ok ? await response.json() : void 0;
    } catch {
      return void 0;
    }
  }
  function normalizeTags2(tags) {
    if (!Array.isArray(tags)) {
      return [];
    }
    return [...new Set(tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  }
  function isEnabledNumber(rule) {
    return rule?.enabled === true && typeof rule.value === "number" && Number.isFinite(rule.value);
  }
  function isIsoDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }
  function createDiscoveryQueueRuleEngine({ getStoreItem } = {}) {
    const reviewsCache = /* @__PURE__ */ new Map();
    const detailsCache = /* @__PURE__ */ new Map();
    function loadCached(cache, appId, url) {
      let payloadPromise = cache.get(appId);
      if (!payloadPromise) {
        payloadPromise = loadJson(url);
        cache.set(appId, payloadPromise);
        payloadPromise.then((payload) => {
          if (payload === void 0 && cache.get(appId) === payloadPromise) {
            cache.delete(appId);
          }
        });
      }
      return payloadPromise;
    }
    async function loadStoreItem(appId) {
      if (typeof getStoreItem !== "function") {
        return {};
      }
      try {
        return parseStoreItem(await getStoreItem(appId), appId);
      } catch {
        return {};
      }
    }
    return {
      async evaluate({ appId, reviews: existingReviews, tags, config }) {
        if (!/^[1-9]\d*$/.test(appId)) {
          throw new TypeError("appId must be a positive integer string");
        }
        if (config?.enabled === false) {
          return { matched: false, reasons: [], data: createEmptyData() };
        }
        const needsPositiveRate = isEnabledNumber(config?.minimumPositiveRate);
        const needsReviewCount = isEnabledNumber(config?.minimumReviewCount) || config?.ignoreUnreviewed === true;
        const needsReviews = needsPositiveRate && existingReviews?.positiveRate === void 0 || needsReviewCount && existingReviews?.reviewCount === void 0;
        const needsPrice = isEnabledNumber(config?.maximumPrice);
        const needsDiscount = isEnabledNumber(config?.minimumDiscount);
        const needsReleaseDate = config?.earliestReleaseDate?.enabled === true && isIsoDate(config.earliestReleaseDate.value);
        const needsFreeStatus = config?.ignoreFree === true;
        const needsDetails = needsPrice || needsDiscount || needsReleaseDate || needsFreeStatus;
        const storeItem = needsReviews || needsDetails ? await loadStoreItem(appId) : {};
        const missingStoreItemReviews = needsPositiveRate && storeItem.positiveRate === void 0 || needsReviewCount && storeItem.reviewCount === void 0;
        const reviewsPromise = missingStoreItemReviews ? loadCached(reviewsCache, appId, `/appreviews/${appId}?json=1&language=all&purchase_type=steam&num_per_page=0`).then(parseReviews) : Promise.resolve({});
        const missingStoreItemData = needsPrice && storeItem.price === void 0 || needsDiscount && storeItem.discount === void 0 || needsReleaseDate && storeItem.releaseDate === void 0 || needsFreeStatus && storeItem.isFree === void 0;
        const detailsPromise = missingStoreItemData ? loadCached(detailsCache, appId, `/api/appdetails?appids=${appId}&l=english`).then((payload) => parseDetails(payload, appId)) : Promise.resolve({});
        const [reviews, details] = await Promise.all([reviewsPromise, detailsPromise]);
        const data = {
          ...createEmptyData(),
          ...reviews,
          ...details,
          ...storeItem,
          ...existingReviews
        };
        const reasons = [];
        if (isEnabledNumber(config?.minimumPositiveRate) && data.positiveRate !== void 0 && data.positiveRate < config.minimumPositiveRate.value) {
          reasons.push("positive-rate");
        }
        if (isEnabledNumber(config?.minimumReviewCount) && data.reviewCount !== void 0 && data.reviewCount < config.minimumReviewCount.value) {
          reasons.push("review-count");
        }
        if (isEnabledNumber(config?.maximumPrice) && data.price !== void 0 && data.price > config.maximumPrice.value) {
          reasons.push("price");
        }
        if (isEnabledNumber(config?.minimumDiscount) && data.discount !== void 0 && data.discount < config.minimumDiscount.value) {
          reasons.push("discount");
        }
        if (config?.earliestReleaseDate?.enabled === true && isIsoDate(config.earliestReleaseDate.value) && data.releaseDate !== void 0 && data.releaseDate < config.earliestReleaseDate.value) {
          reasons.push("release-date");
        }
        if (config?.ignoreFree === true && data.isFree === true) {
          reasons.push("free");
        }
        if (config?.ignoreUnreviewed === true && data.reviewCount === 0) {
          reasons.push("unreviewed");
        }
        if (config?.excludedTags?.enabled === true) {
          const excludedTags = new Set(normalizeTags2(config.excludedTags.value));
          const matchingTags = normalizeTags2(tags).filter((tag) => excludedTags.has(tag)).sort();
          reasons.push(...matchingTags.map((tag) => `tag:${tag}`));
        }
        return { matched: reasons.length > 0, reasons, data };
      },
      clear() {
        reviewsCache.clear();
        detailsCache.clear();
      }
    };
  }

  // src/lib/steam/discovery-queue-auto-filter.js
  function isVisible(element) {
    return Boolean(
      element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden"
    );
  }
  function getAppId(url) {
    try {
      return new URL(url, location.href).pathname.match(/^\/app\/(\d+)(?:\/|$)/)?.[1];
    } catch {
      return void 0;
    }
  }
  function parseReviewCount(value) {
    if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
      return void 0;
    }
    const count = Number(value.trim());
    return Number.isSafeInteger(count) ? count : void 0;
  }
  function parsePositiveRate(value) {
    if (typeof value !== "string") {
      return void 0;
    }
    const match = value.match(/(?<![\d.,])(?<rate>\d{1,3}(?:[.,]\d+)?)\s*%/);
    if (!match?.groups) {
      return void 0;
    }
    const rate = Number(match.groups.rate.replace(",", "."));
    return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : void 0;
  }
  function getClassicReviews() {
    const summary = document.querySelector('.user_reviews_summary_row[itemprop="aggregateRating"]');
    if (!(summary instanceof HTMLElement)) {
      return void 0;
    }
    const reviewCount = parseReviewCount(summary.querySelector('meta[itemprop="reviewCount"]')?.content);
    const positiveRate = parsePositiveRate(summary.dataset.tooltipHtml);
    if (reviewCount === void 0 && positiveRate === void 0) {
      return void 0;
    }
    const reviews = {};
    if (reviewCount !== void 0) {
      reviews.reviewCount = reviewCount;
    }
    if (positiveRate !== void 0) {
      reviews.positiveRate = positiveRate;
    }
    return reviews;
  }
  function getModalQueueAction(target) {
    if (!(target instanceof Element)) {
      return void 0;
    }
    const button = target.closest("[aria-label]");
    const actionGroup = button?.parentElement?.parentElement;
    const dialog = button?.closest('[role="dialog"]');
    const appLink = [...actionGroup?.children ?? []].find(
      (child) => child.matches?.('a[href*="/app/"]')
    );
    if (!(button instanceof HTMLElement) || !(actionGroup instanceof HTMLElement) || !(dialog instanceof HTMLElement) || !(appLink instanceof HTMLAnchorElement) || !dialog.querySelector('a[href*="/explore"][href*="dq=widget"]')) {
      return void 0;
    }
    const actionButtons = [...actionGroup.children].map((child) => child.querySelector("[aria-label]")).filter((element) => element instanceof HTMLElement);
    const actionIndex = actionButtons.indexOf(button);
    if (actionButtons.length !== 2 || actionIndex === -1) {
      return void 0;
    }
    return {
      action: actionIndex === 0 ? "wishlist" : "ignore",
      actionGroup,
      appId: getAppId(appLink.href),
      button,
      dialog,
      initialClassName: button.className
    };
  }
  function findCardRoot(actionGroup, dialog) {
    let current = actionGroup;
    while (current && current !== dialog) {
      if (current.querySelector('a[href*="/tags/"]')) {
        return current;
      }
      current = current.parentElement;
    }
    return actionGroup;
  }
  function getModalContext() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    for (const dialog of dialogs) {
      const queueLink = dialog.querySelector('a[href*="/explore"][href*="dq=widget"]');
      const header = queueLink?.parentElement?.parentElement;
      if (!(header instanceof HTMLElement)) {
        continue;
      }
      const dialogRect = dialog.getBoundingClientRect();
      const candidates = [...dialog.querySelectorAll("[aria-label]")].map((element) => getModalQueueAction(element)).filter((action) => action?.action === "ignore" && action.appId).filter(({ button }) => {
        const rect = button.getBoundingClientRect();
        return isVisible(button) && rect.left >= dialogRect.left && rect.right <= dialogRect.right;
      }).sort((left, right) => right.button.getBoundingClientRect().left - left.button.getBoundingClientRect().left);
      const current = candidates[0];
      if (!current) {
        return { buttonHost: header };
      }
      const cardRoot = findCardRoot(current.actionGroup, dialog);
      const tags = [...cardRoot.querySelectorAll('a[href*="/tags/"]')].map((link) => link.textContent?.trim()).filter(Boolean);
      return {
        appId: current.appId,
        buttonHost: header,
        ignoreButton: current.button,
        key: `modal:${current.appId}:${tags.join("\0")}`,
        tags
      };
    }
    return void 0;
  }
  function getClassicContext() {
    if (new URLSearchParams(location.search).get("queue") !== "1") {
      return void 0;
    }
    const appId = location.pathname.match(/^\/app\/(\d+)(?:\/|$)/)?.[1];
    const buttonHost = document.querySelector("#queueActionsCtn");
    if (!appId || !(buttonHost instanceof HTMLElement)) {
      return void 0;
    }
    const tags = [...document.querySelectorAll(".glance_tags a.app_tag")].map((element) => element.textContent?.trim()).filter(Boolean);
    const reviews = getClassicReviews();
    return {
      appId,
      buttonHost,
      ignoreButton: document.querySelector(".queue_btn_ignore .queue_btn_inactive"),
      key: `classic:${appId}:${reviews?.reviewCount ?? ""}:${reviews?.positiveRate ?? ""}:${tags.join("\0")}`,
      reviews,
      tags
    };
  }
  function startDiscoveryQueueAutoFilter({ getStoreItem } = {}) {
    const ruleEngine = createDiscoveryQueueRuleEngine({ getStoreItem });
    let stopped = false;
    let paused = false;
    let scheduled = false;
    let generation = 0;
    let evaluatedKey;
    const configUi = createDiscoveryQueueConfigUi({
      onSave() {
        generation += 1;
        evaluatedKey = void 0;
        schedule();
      },
      onOpenChange(open) {
        paused = open;
        if (!open) {
          schedule();
        }
      }
    });
    function getContext() {
      return getModalContext() ?? getClassicContext();
    }
    async function evaluateCurrent() {
      scheduled = false;
      const context = getContext();
      if (!context) {
        return;
      }
      configUi.ensureButton(context.buttonHost);
      const config = configUi.getConfig();
      if (paused || !config.enabled || !context.appId || context.key === evaluatedKey) {
        return;
      }
      evaluatedKey = context.key;
      const currentGeneration = ++generation;
      const result = await ruleEngine.evaluate({
        appId: context.appId,
        reviews: context.reviews,
        tags: context.tags,
        config
      });
      if (stopped || paused || currentGeneration !== generation || !result.matched) {
        return;
      }
      const current = getContext();
      if (current?.key === context.key && current.ignoreButton instanceof HTMLElement) {
        current.ignoreButton.click();
      }
    }
    function schedule() {
      if (stopped || scheduled) {
        return;
      }
      scheduled = true;
      requestAnimationFrame(evaluateCurrent);
    }
    const observer = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        if (record.target instanceof Element && record.target.closest('[role="dialog"], #queueActionsCtn')) {
          return true;
        }
        return [...record.addedNodes].some(
          (node) => node instanceof Element && (node.matches('[role="dialog"], #queueActionsCtn') || node.querySelector('[role="dialog"], #queueActionsCtn'))
        );
      });
      if (relevant) {
        schedule();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
    schedule();
    return () => {
      stopped = true;
      generation += 1;
      observer.disconnect();
      configUi.destroy();
      ruleEngine.clear();
    };
  }

  // src/lib/steam/discovery-queue-store-items.js
  var STORE_ITEM_REQUEST = {
    include_release: true,
    include_reviews: true,
    include_tag_count: 20
  };
  var CACHE_WAIT_MS = 50;
  function getStoreItemCache() {
    const cache = window.StoreItemCache;
    return cache && typeof cache.GetApp === "function" && typeof cache.QueueAppRequest === "function" ? cache : void 0;
  }
  async function waitForStoreItemCache() {
    const existing = getStoreItemCache();
    if (existing) {
      return existing;
    }
    const deadline = performance.now() + CACHE_WAIT_MS;
    while (performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const cache = getStoreItemCache();
      if (cache) {
        return cache;
      }
    }
    return void 0;
  }
  function toSafeNonNegativeInteger(value) {
    const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(number) && number >= 0 ? number : void 0;
  }
  function readArray(getter) {
    try {
      const value = getter();
      return Array.isArray(value) ? value.filter((entry) => Number.isSafeInteger(entry) && entry > 0) : [];
    } catch {
      return [];
    }
  }
  function readReviewSummary(item) {
    const preferUnfiltered = window.GDynamicStore?.s_preferences?.review_score_preference === 1;
    const summaryGetter = preferUnfiltered ? item.GetUnfilteredReviewSummary : item.GetFilteredReviewSummary;
    let summary;
    try {
      summary = summaryGetter?.call(item);
    } catch {
      return {};
    }
    const reviewCount = toSafeNonNegativeInteger(summary?.review_count);
    const positiveRate = summary?.percent_positive;
    return {
      reviewCount,
      positiveRate: reviewCount !== 0 && typeof positiveRate === "number" && Number.isFinite(positiveRate) && positiveRate >= 0 && positiveRate <= 100 ? positiveRate : void 0
    };
  }
  function readStoreItem(item, appId) {
    if (!item || typeof item !== "object") {
      return void 0;
    }
    try {
      if (typeof item.GetID === "function" && item.GetID() !== appId) {
        return void 0;
      }
      const purchase = item.GetBestPurchaseOption?.();
      const comingSoon = item.BIsComingSoon?.();
      const reviews = readReviewSummary(item);
      const storeItem = {
        appId,
        success: 1,
        isFree: item.BIsFree?.(),
        comingSoon,
        tagIds: readArray(() => item.GetTagIDs?.()),
        categoryIds: {
          supportedPlayers: readArray(() => item.GetStoreCategories_SupportedPlayers?.()),
          features: readArray(() => item.GetStoreCategories_Features?.()),
          controllers: readArray(() => item.GetStoreCategories_Controller?.())
        },
        ...reviews
      };
      if (comingSoon === false) {
        storeItem.releaseDateUnix = toSafeNonNegativeInteger(item.GetReleaseDateRTime?.(true));
      }
      if (purchase && typeof purchase === "object") {
        storeItem.finalPriceInCents = toSafeNonNegativeInteger(purchase.final_price_in_cents);
        storeItem.originalPriceInCents = toSafeNonNegativeInteger(purchase.original_price_in_cents);
        storeItem.formattedFinalPrice = purchase.formatted_final_price;
        storeItem.formattedOriginalPrice = purchase.formatted_original_price;
        storeItem.discount = toSafeNonNegativeInteger(purchase.discount_pct);
      }
      return storeItem;
    } catch {
      return void 0;
    }
  }
  function createDiscoveryQueueStoreItemReader() {
    let stopped = false;
    return {
      async get(appId) {
        if (stopped || typeof appId !== "string" || !/^[1-9]\d*$/.test(appId)) {
          return void 0;
        }
        const numericAppId = Number(appId);
        if (!Number.isSafeInteger(numericAppId)) {
          return void 0;
        }
        const cache = await waitForStoreItemCache();
        if (!cache || stopped) {
          return void 0;
        }
        try {
          let item = cache.GetApp(numericAppId);
          if (!item?.BContainDataRequest?.(STORE_ITEM_REQUEST)) {
            await cache.QueueAppRequest(numericAppId, STORE_ITEM_REQUEST);
            item = cache.GetApp(numericAppId);
          }
          return readStoreItem(item, numericAppId);
        } catch {
          return void 0;
        }
      },
      stop() {
        stopped = true;
      }
    };
  }

  // src/lib/steam/discovery-queue.js
  var QUEUE_TIMEOUT_MS = 1e4;
  var ADVANCE_DELAY_MS = 50;
  var CLASSIC_NEXT_SELECTOR = "#nextInDiscoveryQueue .btn_next_in_queue_trigger";
  var MODAL_WISHLIST_PATH = "/api/addtowishlist";
  function isVisible2(element) {
    return Boolean(
      element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden"
    );
  }
  function matchesAction(target, selector) {
    return target instanceof Element && target.closest(selector) !== null;
  }
  function startClassicQueue() {
    if (new URLSearchParams(location.search).get("queue") !== "1") {
      return () => {
      };
    }
    const queueActions = document.querySelector("#queueActionsCtn");
    const nextButton = document.querySelector(CLASSIC_NEXT_SELECTOR);
    if (!(queueActions instanceof HTMLElement) || !(nextButton instanceof HTMLElement)) {
      return () => {
      };
    }
    let observer;
    let timer;
    let frame;
    const pendingActions = /* @__PURE__ */ new Set();
    let advancing = false;
    function stopWaiting() {
      observer?.disconnect();
      observer = void 0;
      clearTimeout(timer);
      timer = void 0;
      cancelAnimationFrame(frame);
      frame = void 0;
      pendingActions.clear();
    }
    function advance(delay = ADVANCE_DELAY_MS) {
      stopWaiting();
      advancing = true;
      timer = setTimeout(() => {
        timer = void 0;
        const triggerNext = () => {
          frame = void 0;
          const currentNextButton = document.querySelector(CLASSIC_NEXT_SELECTOR);
          if (currentNextButton instanceof HTMLElement) {
            currentNextButton.click();
          }
          advancing = false;
        };
        if (delay === 0) {
          triggerNext();
        } else {
          frame = requestAnimationFrame(triggerNext);
        }
      }, delay);
    }
    function hasSucceeded() {
      return isVisible2(document.querySelector("#add_to_wishlist_area_success")) && !isVisible2(document.querySelector("#add_to_wishlist_area_fail"));
    }
    function hasFailed() {
      return isVisible2(document.querySelector("#add_to_wishlist_area_fail"));
    }
    function checkResults() {
      for (const action of pendingActions) {
        if (hasSucceeded()) {
          advance();
          return;
        }
        if (hasFailed()) {
          pendingActions.delete(action);
        }
      }
      if (pendingActions.size === 0) {
        stopWaiting();
      }
    }
    function waitForResult(action) {
      if (advancing) {
        return;
      }
      pendingActions.add(action);
      if (observer) {
        return;
      }
      observer = new MutationObserver(checkResults);
      observer.observe(queueActions, {
        attributes: true,
        attributeFilter: ["class", "style"],
        childList: true,
        subtree: true
      });
      timer = setTimeout(stopWaiting, QUEUE_TIMEOUT_MS);
    }
    function handleClick(event) {
      const { target } = event;
      if (matchesAction(target, "#add_to_wishlist_area a.add_to_wishlist")) {
        waitForResult("wishlist");
      } else if (matchesAction(target, ".queue_btn_ignore .queue_btn_inactive") || matchesAction(target, "#queue_ignore_menu_option_not_interested") || matchesAction(target, "#queue_ignore_menu_option_owned_elsewhere")) {
        advance(0);
      }
    }
    function stop() {
      stopWaiting();
      queueActions.removeEventListener("click", handleClick, true);
      window.removeEventListener("pagehide", stop);
    }
    queueActions.addEventListener("click", handleClick, true);
    window.addEventListener("pagehide", stop, { once: true });
    return stop;
  }
  function findModalNextButton(dialog) {
    const dialogRect = dialog.getBoundingClientRect();
    const dialogCenter = dialogRect.left + dialogRect.width / 2;
    const dialogMiddle = dialogRect.top + dialogRect.height / 2;
    const maximumEdgeGap = Math.min(320, dialogRect.width * 0.15);
    const maximumMiddleGap = Math.min(240, dialogRect.height * 0.2);
    const candidates = [
      ...dialog.querySelectorAll('[role="button"][aria-label]')
    ].map((element) => {
      const rect = element.getBoundingClientRect();
      return { element, rect };
    }).filter(
      ({ rect }) => rect.width >= 40 && rect.width <= 96 && rect.height >= 40 && rect.height <= 96
    ).filter(
      ({ element, rect }) => isVisible2(element) && rect.left + rect.width / 2 > dialogCenter && dialogRect.right - rect.right <= maximumEdgeGap && Math.abs(rect.top + rect.height / 2 - dialogMiddle) <= maximumMiddleGap
    ).sort(
      (left, right) => dialogRect.right - left.rect.right - (dialogRect.right - right.rect.right) || Math.abs(left.rect.top + left.rect.height / 2 - dialogMiddle) - Math.abs(right.rect.top + right.rect.height / 2 - dialogMiddle)
    );
    return candidates[0]?.element;
  }
  function getMonitoredPath(input, init) {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method.toUpperCase() !== "POST") {
      return void 0;
    }
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl, location.href);
    if (url.origin !== location.origin) {
      return void 0;
    }
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return pathname === MODAL_WISHLIST_PATH ? pathname : void 0;
  }
  function monitorActionRequests(takePending, handleResult) {
    if (typeof window.fetch !== "function") {
      return () => {
      };
    }
    const originalFetch = window.fetch;
    function monitoredFetch(...args) {
      const response = Reflect.apply(originalFetch, this, args);
      let pathname;
      try {
        pathname = getMonitoredPath(args[0], args[1]);
      } catch {
        return response;
      }
      if (!pathname) {
        return response;
      }
      const pending = takePending(pathname);
      if (!pending) {
        return response;
      }
      return response.then(
        (result) => {
          handleResult(pending, result.ok);
          return result;
        },
        (error) => {
          handleResult(pending, false);
          throw error;
        }
      );
    }
    window.fetch = monitoredFetch;
    return () => {
      if (window.fetch === monitoredFetch) {
        window.fetch = originalFetch;
      }
    };
  }
  function startModalQueue() {
    const requestQueues = /* @__PURE__ */ new Map();
    const pendingActions = /* @__PURE__ */ new Set();
    let advanceFrame;
    let advancing = false;
    function removePending(pending) {
      clearTimeout(pending.timer);
      clearTimeout(pending.stabilityTimer);
      pending.observer?.disconnect();
      pendingActions.delete(pending);
      const queue = requestQueues.get(pending.pathname);
      const index = queue?.indexOf(pending) ?? -1;
      if (index !== -1) {
        queue.splice(index, 1);
        if (queue.length === 0) {
          requestQueues.delete(pending.pathname);
        }
      }
    }
    function clearPending() {
      for (const pending of [...pendingActions]) {
        removePending(pending);
      }
    }
    function advance(pending, immediate = false) {
      if (advancing) {
        return;
      }
      advancing = true;
      clearPending();
      const deadline = performance.now() + QUEUE_TIMEOUT_MS;
      const triggerNext = () => {
        advanceFrame = void 0;
        if (!pending.dialog.isConnected) {
          advancing = false;
          return;
        }
        const nextButton = findModalNextButton(pending.dialog);
        if (nextButton) {
          nextButton.click();
          advancing = false;
          return;
        }
        if (performance.now() >= deadline) {
          advancing = false;
          return;
        }
        advanceFrame = requestAnimationFrame(triggerNext);
      };
      if (immediate) {
        triggerNext();
      } else {
        advanceFrame = requestAnimationFrame(triggerNext);
      }
    }
    function waitForSelectedState(pending) {
      function checkState() {
        clearTimeout(pending.stabilityTimer);
        if (!pending.button.isConnected || pending.button.className === pending.initialClassName) {
          return;
        }
        pending.stabilityTimer = setTimeout(() => {
          if (pending.button.isConnected && pending.button.className !== pending.initialClassName) {
            advance(pending);
          }
        }, ADVANCE_DELAY_MS);
      }
      pending.observer = new MutationObserver(checkState);
      pending.observer.observe(pending.button, {
        attributes: true,
        attributeFilter: ["class"]
      });
      checkState();
    }
    const stopMonitoringRequests = monitorActionRequests(
      (pathname) => {
        const queue = requestQueues.get(pathname);
        const pending = queue?.shift();
        if (!pending) {
          return void 0;
        }
        if (queue.length === 0) {
          requestQueues.delete(pathname);
        }
        return pending;
      },
      (pending, succeeded) => {
        if (!pendingActions.has(pending)) {
          return;
        }
        if (succeeded) {
          waitForSelectedState(pending);
        } else {
          removePending(pending);
        }
      }
    );
    function handleClick(event) {
      const modalAction = getModalQueueAction(event.target);
      if (!modalAction || advancing) {
        return;
      }
      if (modalAction.action === "ignore") {
        advance(modalAction, true);
        return;
      }
      const pending = {
        ...modalAction,
        pathname: MODAL_WISHLIST_PATH
      };
      pending.timer = setTimeout(() => removePending(pending), QUEUE_TIMEOUT_MS);
      pendingActions.add(pending);
      const queue = requestQueues.get(MODAL_WISHLIST_PATH) ?? [];
      queue.push(pending);
      requestQueues.set(MODAL_WISHLIST_PATH, queue);
    }
    function stop() {
      cancelAnimationFrame(advanceFrame);
      advanceFrame = void 0;
      advancing = false;
      stopMonitoringRequests();
      clearPending();
      document.removeEventListener("click", handleClick, true);
      window.removeEventListener("pagehide", stop);
    }
    document.addEventListener("click", handleClick, true);
    window.addEventListener("pagehide", stop, { once: true });
    return stop;
  }
  function startSteamDiscoveryQueue() {
    const storeItemReader = createDiscoveryQueueStoreItemReader();
    const stopModalQueue = startModalQueue();
    let stopClassicQueue = () => {
    };
    let stopAutoFilter = () => {
    };
    let stopped = false;
    function startQueueControllersWhenReady() {
      if (!stopped) {
        stopClassicQueue = startClassicQueue();
        stopAutoFilter = startDiscoveryQueueAutoFilter({
          getStoreItem: storeItemReader.get
        });
      }
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startQueueControllersWhenReady, {
        once: true
      });
    } else {
      startQueueControllersWhenReady();
    }
    return () => {
      stopped = true;
      document.removeEventListener("DOMContentLoaded", startQueueControllersWhenReady);
      stopModalQueue();
      stopClassicQueue();
      stopAutoFilter();
      storeItemReader.stop();
    };
  }

  // src/userscripts/steam-discovery-queue.user.js
  startSteamDiscoveryQueue();
})();
