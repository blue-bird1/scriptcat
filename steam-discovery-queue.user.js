// ==UserScript==
// @name         Steam Discovery Queue Auto Next
// @name:zh-CN   Steam 探索队列自动下一项
// @namespace    https://github.com/blue-bird1/scriptcat
// @version      0.3.12
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
  // src/lib/steam/discovery-queue-languages.js
  var STEAM_LANGUAGE_OPTIONS = [
    { value: 0, label: "英语" },
    { value: 1, label: "德语" },
    { value: 2, label: "法语" },
    { value: 3, label: "意大利语" },
    { value: 4, label: "韩语" },
    { value: 5, label: "西班牙语" },
    { value: 6, label: "简体中文" },
    { value: 7, label: "繁体中文" },
    { value: 8, label: "俄语" },
    { value: 9, label: "泰语" },
    { value: 10, label: "日语" },
    { value: 11, label: "葡萄牙语" },
    { value: 12, label: "波兰语" },
    { value: 13, label: "丹麦语" },
    { value: 14, label: "荷兰语" },
    { value: 15, label: "芬兰语" },
    { value: 16, label: "挪威语" },
    { value: 17, label: "瑞典语" },
    { value: 18, label: "匈牙利语" },
    { value: 19, label: "捷克语" },
    { value: 20, label: "罗马尼亚语" },
    { value: 21, label: "土耳其语" },
    { value: 22, label: "巴西葡萄牙语" },
    { value: 23, label: "保加利亚语" },
    { value: 24, label: "阿拉伯语" },
    { value: 25, label: "乌克兰语" },
    { value: 26, label: "越南语" },
    { value: 27, label: "拉丁美洲西班牙语" },
    { value: 28, label: "希腊语" },
    { value: 29, label: "Steam 中国简体中文" },
    { value: 30, label: "印度尼西亚语" },
    { value: 31, label: "马来语" }
  ];

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
    ignoreDlc: false,
    ignoreProfileFeaturesLimited: false,
    autoContinueQueue: false,
    excludedTags: { enabled: false, value: [] },
    requiredLanguages: { enabled: false, value: [6, 7] }
  };
  function cloneDefaultConfig() {
    return {
      ...DEFAULT_DISCOVERY_QUEUE_CONFIG,
      minimumPositiveRate: { ...DEFAULT_DISCOVERY_QUEUE_CONFIG.minimumPositiveRate },
      minimumReviewCount: { ...DEFAULT_DISCOVERY_QUEUE_CONFIG.minimumReviewCount },
      maximumPrice: { ...DEFAULT_DISCOVERY_QUEUE_CONFIG.maximumPrice },
      minimumDiscount: { ...DEFAULT_DISCOVERY_QUEUE_CONFIG.minimumDiscount },
      earliestReleaseDate: { ...DEFAULT_DISCOVERY_QUEUE_CONFIG.earliestReleaseDate },
      ignoreDlc: DEFAULT_DISCOVERY_QUEUE_CONFIG.ignoreDlc,
      ignoreProfileFeaturesLimited: DEFAULT_DISCOVERY_QUEUE_CONFIG.ignoreProfileFeaturesLimited,
      autoContinueQueue: DEFAULT_DISCOVERY_QUEUE_CONFIG.autoContinueQueue,
      excludedTags: { ...DEFAULT_DISCOVERY_QUEUE_CONFIG.excludedTags, value: [] },
      requiredLanguages: {
        ...DEFAULT_DISCOVERY_QUEUE_CONFIG.requiredLanguages,
        value: [...DEFAULT_DISCOVERY_QUEUE_CONFIG.requiredLanguages.value]
      }
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
  function normalizeLanguages(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const selected = new Set(value.filter((language) => Number.isInteger(language)));
    return STEAM_LANGUAGE_OPTIONS.filter((language) => selected.has(language.value)).map(
      (language) => language.value
    );
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
    const languages = isRecord(value.requiredLanguages) ? value.requiredLanguages : fallback.requiredLanguages;
    const requiredLanguages = normalizeLanguages(languages.value);
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
      ignoreDlc: normalizeBoolean(value.ignoreDlc, fallback.ignoreDlc),
      ignoreProfileFeaturesLimited: normalizeBoolean(
        value.ignoreProfileFeaturesLimited,
        fallback.ignoreProfileFeaturesLimited
      ),
      autoContinueQueue: normalizeBoolean(
        value.autoContinueQueue,
        fallback.autoContinueQueue
      ),
      excludedTags: {
        enabled: normalizeBoolean(tags.enabled, fallback.excludedTags.enabled),
        value: normalizeTags(tags.value)
      },
      requiredLanguages: {
        enabled: requiredLanguages.length > 0 && normalizeBoolean(languages.enabled, fallback.requiredLanguages.enabled),
        value: requiredLanguages
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
    style.textContent = `#${BUTTON_ID}{margin-left:auto}.scriptcat-discovery-queue-config-backdrop{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72)}.scriptcat-discovery-queue-config-popup{box-sizing:border-box;width:min(680px,calc(100vw - 32px));max-height:calc(100vh - 32px);padding:24px;overflow:auto;border:1px solid #000;background:linear-gradient(135deg,#1b2838 0%,#2a475e 100%);box-shadow:0 0 24px #000}.scriptcat-discovery-queue-config-popup h2{margin-top:0;color:#fff}.scriptcat-discovery-queue-config-fields{display:grid;gap:12px;margin:20px 0}.scriptcat-discovery-queue-config-rule{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.scriptcat-discovery-queue-config-rule>input{min-width:140px}.scriptcat-discovery-queue-config-option{display:flex;align-items:center;gap:6px}.scriptcat-discovery-queue-config-tags{display:flex;gap:6px;align-items:center;flex:1;flex-wrap:wrap}.scriptcat-discovery-queue-config-chip{display:inline-flex;gap:4px;align-items:center;padding:3px 6px;background:#16202d}.scriptcat-discovery-queue-config-languages{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));width:100%;max-height:180px;padding:10px;overflow:auto;border:1px solid #000;background:rgba(0,0,0,.24);box-sizing:border-box}.scriptcat-discovery-queue-config-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}`;
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
    let selectedLanguages = /* @__PURE__ */ new Set();
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
      selectedLanguages = new Set(draft.requiredLanguages.value);
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
      const ignoreDlc = addCheckbox(fields, "忽略 DLC / 下载内容", draft.ignoreDlc);
      const ignoreProfileFeaturesLimited = addCheckbox(
        fields,
        "忽略个人资料功能受限的游戏",
        draft.ignoreProfileFeaturesLimited
      );
      const autoContinueQueue = addCheckbox(
        fields,
        "探索结束后自动继续下一次",
        draft.autoContinueQueue
      );
      const tagRow = createElement("div", "scriptcat-discovery-queue-config-rule");
      const tagEnabled = addCheckbox(tagRow, "排除标签", draft.excludedTags.enabled);
      const tagContainer = createElement("div", "scriptcat-discovery-queue-config-tags");
      const tagInput = createElement("input");
      tagInput.type = "text";
      tagInput.placeholder = "输入标签后按回车或逗号";
      tagContainer.append(tagInput);
      tagRow.append(tagContainer);
      fields.append(tagRow);
      const languageRow = createElement("div", "scriptcat-discovery-queue-config-rule");
      const languageEnabled = addCheckbox(languageRow, "必须包含任一所选语言", draft.requiredLanguages.enabled);
      const languageContainer = createElement("div", "scriptcat-discovery-queue-config-languages");
      const languageInputs = /* @__PURE__ */ new Map();
      for (const language of STEAM_LANGUAGE_OPTIONS) {
        const input = addCheckbox(
          languageContainer,
          language.label,
          selectedLanguages.has(language.value)
        );
        languageInputs.set(language.value, input);
      }
      languageRow.append(languageContainer);
      fields.append(languageRow);
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
      function syncLanguageRule() {
        selectedLanguages = new Set(
          [...languageInputs].filter(([, input]) => input.checked).map(([language]) => language)
        );
        if (selectedLanguages.size === 0) {
          languageEnabled.checked = false;
        }
        languageEnabled.disabled = selectedLanguages.size === 0;
      }
      for (const input of languageInputs.values()) {
        input.addEventListener("change", syncLanguageRule);
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
        ignoreDlc.checked = defaults.ignoreDlc;
        ignoreProfileFeaturesLimited.checked = defaults.ignoreProfileFeaturesLimited;
        autoContinueQueue.checked = defaults.autoContinueQueue;
        tagEnabled.checked = defaults.excludedTags.enabled;
        tags = [];
        renderTags();
        for (const [language, input] of languageInputs) {
          input.checked = defaults.requiredLanguages.value.includes(language);
        }
        languageEnabled.checked = defaults.requiredLanguages.enabled;
        syncLanguageRule();
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
          ignoreDlc: ignoreDlc.checked,
          ignoreProfileFeaturesLimited: ignoreProfileFeaturesLimited.checked,
          autoContinueQueue: autoContinueQueue.checked,
          excludedTags: { enabled: tagEnabled.checked, value: tags },
          requiredLanguages: {
            enabled: languageEnabled.checked,
            value: [...selectedLanguages]
          }
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
      syncLanguageRule();
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

  // src/lib/steam/discovery-queue-profile-features.js
  var PROFILE_PROGRESS_ENDPOINT = "https://api.steampowered.com/IPlayerService/GetAchievementsProgress/v1/";
  function readApplicationConfig() {
    const applicationConfig = document.getElementById("application_config");
    if (!(applicationConfig instanceof HTMLElement)) {
      return void 0;
    }
    try {
      const userInfo = JSON.parse(applicationConfig.dataset.userinfo ?? "");
      const storeUserConfig = JSON.parse(
        applicationConfig.dataset.store_user_config ?? ""
      );
      const steamId = userInfo?.steamid;
      const accessToken = storeUserConfig?.webapi_token;
      return typeof steamId === "string" && /^\d{17}$/.test(steamId) && typeof accessToken === "string" && accessToken ? { steamId, accessToken } : void 0;
    } catch {
      return void 0;
    }
  }
  function parseProfileFeaturesLimited(payload, appId) {
    const progress = payload?.response?.achievement_progress;
    if (!Array.isArray(progress)) {
      return void 0;
    }
    const matching = progress.find((entry) => String(entry?.appid) === appId);
    if (!matching || typeof matching !== "object") {
      return void 0;
    }
    if (!Object.hasOwn(matching, "vetted")) {
      return true;
    }
    return typeof matching.vetted === "boolean" ? !matching.vetted : void 0;
  }
  function createProfileFeaturesLimitedReader() {
    const cache = /* @__PURE__ */ new Map();
    let requestChain = Promise.resolve();
    let requestGeneration = 0;
    let requestsBlocked = false;
    async function request(appId, generation) {
      if (requestsBlocked || generation !== requestGeneration) {
        return void 0;
      }
      const credentials = readApplicationConfig();
      if (!credentials) {
        return void 0;
      }
      const url = new URL(PROFILE_PROGRESS_ENDPOINT);
      url.searchParams.set("access_token", credentials.accessToken);
      const body = new FormData();
      body.set(
        "input_json",
        JSON.stringify({
          steamid: credentials.steamId,
          language: typeof window.g_strLanguage === "string" && window.g_strLanguage ? window.g_strLanguage : "english",
          appids: [Number(appId)],
          include_unvetted_apps: true
        })
      );
      try {
        const response = await fetch(url, {
          method: "POST",
          body
        });
        if (generation !== requestGeneration) {
          return void 0;
        }
        if (response.status === 429) {
          requestsBlocked = true;
          return void 0;
        }
        return response.ok ? parseProfileFeaturesLimited(await response.json(), appId) : void 0;
      } catch {
        return void 0;
      }
    }
    return {
      get(appId) {
        let statusPromise = cache.get(appId);
        if (!statusPromise) {
          const generation = requestGeneration;
          statusPromise = requestChain.then(() => request(appId, generation));
          requestChain = statusPromise.then(
            () => void 0,
            () => void 0
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
      isDlc: void 0,
      profileFeaturesLimited: void 0,
      isFree: void 0,
      price: void 0,
      currency: void 0,
      discount: void 0,
      releaseDate: void 0,
      descriptionHasChinese: void 0,
      supportedLanguages: void 0
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
    const type = typeof details.data.type === "string" ? details.data.type.trim().toLowerCase() : "";
    if (type) {
      result.isDlc = type === "dlc";
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
    if (typeof storeItem.descriptionHasChinese === "boolean") {
      result.descriptionHasChinese = storeItem.descriptionHasChinese;
    }
    if (Array.isArray(storeItem.supportedLanguages)) {
      result.supportedLanguages = [
        ...new Set(
          storeItem.supportedLanguages.filter(
            (language) => Number.isSafeInteger(language) && language >= 0
          )
        )
      ];
    }
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
    if (typeof storeItem.isDlc === "boolean") {
      result.isDlc = storeItem.isDlc;
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
  function getRequiredLanguages(rule) {
    return rule?.enabled === true && Array.isArray(rule.value) ? [
      ...new Set(
        rule.value.filter(
          (language) => Number.isSafeInteger(language) && language >= 0
        )
      )
    ] : [];
  }
  function hasRequiredChineseLanguage(requiredLanguages) {
    return requiredLanguages.includes(6) || requiredLanguages.includes(7) || requiredLanguages.includes(29);
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
    const profileFeaturesLimitedReader = createProfileFeaturesLimitedReader();
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
    async function loadStoreItem(appId, requirements) {
      if (typeof getStoreItem !== "function") {
        return {};
      }
      try {
        return parseStoreItem(await getStoreItem(appId, requirements), appId);
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
        const needsDlc = config?.ignoreDlc === true;
        const needsDetails = needsPrice || needsDiscount || needsReleaseDate || needsFreeStatus || needsDlc;
        const requiredLanguages = getRequiredLanguages(config?.requiredLanguages);
        const needsSupportedLanguages = requiredLanguages.length > 0;
        const storeItem = needsReviews || needsDetails || needsSupportedLanguages ? await loadStoreItem(appId, {
          needsReviews,
          needsReleaseDate,
          needsDlc,
          requiredLanguages
        }) : {};
        const missingStoreItemReviews = needsPositiveRate && storeItem.positiveRate === void 0 || needsReviewCount && storeItem.reviewCount === void 0;
        const reviewsPromise = missingStoreItemReviews ? loadCached(reviewsCache, appId, `/appreviews/${appId}?json=1&language=all&purchase_type=steam&num_per_page=0`).then(parseReviews) : Promise.resolve({});
        const missingStoreItemData = needsPrice && storeItem.price === void 0 || needsDiscount && storeItem.discount === void 0 || needsReleaseDate && storeItem.releaseDate === void 0 || needsFreeStatus && storeItem.isFree === void 0 || needsDlc && storeItem.isDlc === void 0;
        const detailsPromise = missingStoreItemData ? loadCached(detailsCache, appId, `/api/appdetails?appids=${appId}&l=english`).then((payload) => parseDetails(payload, appId)) : Promise.resolve({});
        const [reviews, details] = await Promise.all([reviewsPromise, detailsPromise]);
        const data = {
          ...createEmptyData(),
          ...reviews,
          ...details,
          ...storeItem,
          ...existingReviews
        };
        const descriptionMatchesRequiredLanguage = data.descriptionHasChinese === true && hasRequiredChineseLanguage(requiredLanguages);
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
        if (config?.ignoreDlc === true && data.isDlc === true) {
          reasons.push("dlc");
        }
        if (needsSupportedLanguages && !descriptionMatchesRequiredLanguage && Array.isArray(data.supportedLanguages) && !requiredLanguages.some(
          (language) => data.supportedLanguages.includes(language)
        )) {
          reasons.push("required-language");
        }
        if (config?.excludedTags?.enabled === true) {
          const excludedTags = new Set(normalizeTags2(config.excludedTags.value));
          const matchingTags = normalizeTags2(tags).filter((tag) => excludedTags.has(tag)).sort();
          reasons.push(...matchingTags.map((tag) => `tag:${tag}`));
        }
        if (reasons.length > 0 || config?.ignoreProfileFeaturesLimited !== true) {
          return { matched: reasons.length > 0, reasons, data };
        }
        const profileFeaturesLimited = await profileFeaturesLimitedReader.get(appId);
        if (typeof profileFeaturesLimited === "boolean") {
          data.profileFeaturesLimited = profileFeaturesLimited;
        }
        if (profileFeaturesLimited === true) {
          reasons.push("profile-features-limited");
        }
        return { matched: reasons.length > 0, reasons, data };
      },
      clear() {
        reviewsCache.clear();
        detailsCache.clear();
        profileFeaturesLimitedReader.clear();
      }
    };
  }

  // src/lib/steam/discovery-queue-auto-filter.js
  var QUEUE_OBSERVER_SELECTOR = '[role="dialog"], #queueActionsCtn, .discover_queue_empty';
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
  function getModalContinueButton() {
    const dialog = document.querySelector(
      '[role="dialog"]:has(a[href*="/explore"][href*="dq=widget"])'
    );
    const wishlistLink = dialog?.querySelector('a[href*="/wishlist"]');
    const ignoredLink = dialog?.querySelector('a[href*="/account/notinterested"]');
    if (!(dialog instanceof HTMLElement) || !(wishlistLink instanceof HTMLAnchorElement) || !(ignoredLink instanceof HTMLAnchorElement)) {
      return void 0;
    }
    const wishlistStatistic = wishlistLink.parentElement;
    const ignoredStatistic = ignoredLink.parentElement;
    const statisticsRoot = wishlistStatistic?.parentElement;
    if (!(statisticsRoot instanceof HTMLElement) || ignoredStatistic?.parentElement !== statisticsRoot) {
      return void 0;
    }
    const summaryContent = statisticsRoot.parentElement;
    const summaryCard = summaryContent?.parentElement;
    const actionParent = statisticsRoot.nextElementSibling;
    if (!(summaryContent instanceof HTMLElement) || !(summaryCard instanceof HTMLElement) || !summaryCard.matches('[role="button"][tabindex="0"]') || !(actionParent instanceof HTMLElement) || actionParent.parentElement !== summaryContent) {
      return void 0;
    }
    const actions = [...actionParent.children].filter(
      (element) => element instanceof HTMLElement && isVisible(element)
    );
    return actions.length === 2 ? actions[1] : void 0;
  }
  function getClassicContinueLink() {
    if (new URLSearchParams(location.search).get("queue") !== "1") {
      return void 0;
    }
    const emptyQueue = [...document.querySelectorAll(".discover_queue_empty")].find(
      isVisible
    );
    if (!(emptyQueue instanceof HTMLElement)) {
      return void 0;
    }
    return [...emptyQueue.querySelectorAll("a[href]")].find((link) => {
      if (!(link instanceof HTMLAnchorElement) || !isVisible(link)) {
        return false;
      }
      try {
        const url = new URL(link.href, location.href);
        return url.origin === location.origin && /^\/explore\/startnew\/0\/?$/.test(url.pathname);
      } catch {
        return false;
      }
    });
  }
  function startDiscoveryQueueAutoFilter({ getStoreItem } = {}) {
    const ruleEngine = createDiscoveryQueueRuleEngine({ getStoreItem });
    const continuedModalButtons = /* @__PURE__ */ new WeakSet();
    const continuedClassicLinks = /* @__PURE__ */ new WeakSet();
    let stopped = false;
    let paused = false;
    let scheduled = false;
    let generation = 0;
    let evaluatedKey;
    let activeConfig;
    const configUi = createDiscoveryQueueConfigUi({
      onSave() {
        activeConfig = configUi.getConfig();
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
    activeConfig = configUi.getConfig();
    function getContext() {
      return getModalContext() ?? getClassicContext();
    }
    async function evaluateCurrent() {
      scheduled = false;
      const config = activeConfig ?? configUi.getConfig();
      if (paused) {
        return;
      }
      if (config.autoContinueQueue) {
        const modalContinueButton = getModalContinueButton();
        if (modalContinueButton instanceof HTMLElement && !continuedModalButtons.has(modalContinueButton)) {
          continuedModalButtons.add(modalContinueButton);
          modalContinueButton.click();
          return;
        }
        const classicContinueLink = getClassicContinueLink();
        if (classicContinueLink instanceof HTMLAnchorElement && !continuedClassicLinks.has(classicContinueLink)) {
          continuedClassicLinks.add(classicContinueLink);
          classicContinueLink.click();
          return;
        }
      }
      const context = getContext();
      if (!context) {
        return;
      }
      configUi.ensureButton(context.buttonHost);
      if (!config.enabled || !context.appId || context.key === evaluatedKey) {
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
        if (record.target instanceof Element && record.target.closest(QUEUE_OBSERVER_SELECTOR)) {
          return true;
        }
        return [...record.addedNodes].some(
          (node) => node instanceof Element && (node.matches(QUEUE_OBSERVER_SELECTOR) || node.querySelector(QUEUE_OBSERVER_SELECTOR))
        );
      });
      if (relevant) {
        schedule();
      }
    });
    observer.observe(document, {
      attributes: true,
      attributeFilter: ["class", "style"],
      childList: true,
      subtree: true
    });
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
  var CACHE_WAIT_MS = 50;
  var CHINESE_LANGUAGE_IDS = /* @__PURE__ */ new Set([6, 7, 29]);
  var DLC_APP_TYPE = 4;
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
  function readSupportedLanguages(item) {
    if (typeof item.GetAllLanguagesWithSomeSupport !== "function") {
      return void 0;
    }
    try {
      const languages = item.GetAllLanguagesWithSomeSupport();
      return Array.isArray(languages) ? [
        ...new Set(
          languages.filter(
            (language) => Number.isSafeInteger(language) && language >= 0
          )
        )
      ] : void 0;
    } catch {
      return void 0;
    }
  }
  function readDescriptionHasChinese(item) {
    if (typeof item.GetShortDescription !== "function") {
      return void 0;
    }
    try {
      const description = item.GetShortDescription();
      return typeof description === "string" ? /\p{Script=Han}/u.test(description) : void 0;
    } catch {
      return void 0;
    }
  }
  function readAppType(item) {
    if (typeof item?.GetAppType !== "function") {
      return void 0;
    }
    try {
      const appType = item.GetAppType();
      return Number.isSafeInteger(appType) && appType >= 0 ? appType : void 0;
    } catch {
      return void 0;
    }
  }
  function buildStoreItemRequest(requirements, descriptionHasChinese, appType) {
    const request = {};
    if (requirements?.needsReviews === true) {
      request.include_reviews = true;
    }
    if (requirements?.needsReleaseDate === true) {
      request.include_release = true;
    }
    if (requirements?.needsDlc === true && appType === void 0) {
      request.include_basic_info = true;
    }
    const requiredLanguages = Array.isArray(requirements?.requiredLanguages) ? requirements.requiredLanguages : [];
    const acceptsChineseDescription = requiredLanguages.some(
      (language) => CHINESE_LANGUAGE_IDS.has(language)
    );
    if (requiredLanguages.length > 0 && !(acceptsChineseDescription && descriptionHasChinese)) {
      request.include_supported_languages = true;
    }
    return request;
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
      const appType = readAppType(item);
      const reviews = readReviewSummary(item);
      const storeItem = {
        appId,
        success: 1,
        isFree: item.BIsFree?.(),
        comingSoon,
        descriptionHasChinese: readDescriptionHasChinese(item),
        isDlc: appType === void 0 ? void 0 : appType === DLC_APP_TYPE,
        supportedLanguages: readSupportedLanguages(item),
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
      async get(appId, requirements) {
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
          const request = buildStoreItemRequest(
            requirements,
            readDescriptionHasChinese(item),
            readAppType(item)
          );
          if (Object.keys(request).length > 0 && !item?.BContainDataRequest?.(request)) {
            await cache.QueueAppRequest(numericAppId, request);
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
