// ==UserScript==
// @name         Steam Discovery Queue Auto Next
// @name:zh-CN   Steam 探索队列自动下一项
// @namespace    https://github.com/blue-bird1/scriptcat
// @version      0.3.19
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
  function loadDiscoveryQueueConfig(logger2) {
    try {
      const serialized = localStorage.getItem(STORAGE_KEY);
      const config = serialized === null ? cloneDefaultConfig() : normalizeConfig(JSON.parse(serialized));
      logger2?.debug("config.loaded", {
        source: serialized === null ? "default" : "localStorage"
      });
      return config;
    } catch (error) {
      logger2?.error("config.load_failed", error, { fallback: "default" });
      return cloneDefaultConfig();
    }
  }
  function saveDiscoveryQueueConfig(value, logger2) {
    const config = normalizeConfig(value);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      logger2?.info("config.persisted", { enabled: config.enabled });
    } catch (error) {
      logger2?.error("config.persist_failed", error, {
        enabled: config.enabled
      });
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
  function createDiscoveryQueueConfigUi({ logger: logger2, onSave, onOpenChange } = {}) {
    const uiLogger = logger2?.child("config-ui");
    let config = loadDiscoveryQueueConfig(uiLogger);
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
      uiLogger?.info("popup.closed");
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
        uiLogger?.debug("popup.open_suppressed", { reason: "already-open" });
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
      uiLogger?.info("popup.opened", {
        host: popupHost === document.body ? "document-body" : "queue-dialog"
      });
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
        }, uiLogger);
        uiLogger?.info("popup.saved", {
          autoContinueQueue: config.autoContinueQueue,
          enabled: config.enabled
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
  function readApplicationConfig(logger2) {
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
    } catch (error) {
      logger2?.error("credentials.parse.error", error);
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
  function createProfileFeaturesLimitedReader({ logger: logger2 } = {}) {
    const cache = /* @__PURE__ */ new Map();
    const diagnostics = /* @__PURE__ */ new Map();
    let requestChain = Promise.resolve();
    let requestGeneration = 0;
    let requestsBlocked = false;
    async function request(appId, generation) {
      if (requestsBlocked || generation !== requestGeneration) {
        diagnostics.set(appId, {
          kind: "unavailable",
          reason: requestsBlocked ? "rate-limited" : "generation-cancelled"
        });
        logger2?.debug("request.skipped", {
          appId,
          generation,
          reason: requestsBlocked ? "rate-limited" : "generation-cancelled",
          requestGeneration
        });
        return void 0;
      }
      const credentials = readApplicationConfig(logger2);
      if (!credentials) {
        diagnostics.set(appId, {
          kind: "unavailable",
          reason: "credentials-unavailable"
        });
        logger2?.warn("request.skipped", {
          appId,
          reason: "credentials-unavailable"
        });
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
      const startedAt = performance.now();
      logger2?.debug("request.started", { appId, generation });
      try {
        const response = await fetch(url, {
          method: "POST",
          body
        });
        if (generation !== requestGeneration) {
          diagnostics.set(appId, {
            kind: "unavailable",
            reason: "generation-cancelled"
          });
          logger2?.info("request.cancelled", {
            appId,
            durationMs: performance.now() - startedAt,
            generation,
            requestGeneration,
            stage: "response"
          });
          return void 0;
        }
        if (response.status === 429) {
          requestsBlocked = true;
          diagnostics.set(appId, {
            kind: "http",
            status: response.status,
            statusText: response.statusText
          });
          logger2?.warn("request.rate-limited", {
            appId,
            durationMs: performance.now() - startedAt,
            status: response.status,
            statusText: response.statusText
          });
          return void 0;
        }
        if (!response.ok) {
          diagnostics.set(appId, {
            kind: "http",
            status: response.status,
            statusText: response.statusText
          });
          logger2?.warn("request.http-error", {
            appId,
            durationMs: performance.now() - startedAt,
            status: response.status,
            statusText: response.statusText
          });
          return void 0;
        }
        const value = parseProfileFeaturesLimited(await response.json(), appId);
        if (value === void 0) {
          diagnostics.set(appId, {
            kind: "invalid-response",
            reason: "profile-status-unresolved"
          });
        } else {
          diagnostics.delete(appId);
        }
        logger2?.debug("request.completed", {
          appId,
          durationMs: performance.now() - startedAt,
          status: response.status,
          value
        });
        return value;
      } catch (error) {
        diagnostics.set(appId, { error, kind: "exception" });
        logger2?.error("request.error", error, {
          appId,
          durationMs: performance.now() - startedAt
        });
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
      getDiagnostic(appId) {
        return diagnostics.get(appId);
      },
      clear() {
        requestGeneration += 1;
        logger2?.info("generation.cleared", { requestGeneration });
        cache.clear();
        diagnostics.clear();
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
  async function loadJson(url, logger2, source, appId) {
    const startedAt = performance.now();
    logger2?.debug("request.started", { appId, source, url });
    try {
      const response = await fetch(url);
      if (!response.ok) {
        const diagnostic = {
          kind: "http",
          status: response.status,
          statusText: response.statusText
        };
        logger2?.warn("request.http-error", {
          appId,
          durationMs: performance.now() - startedAt,
          source,
          url,
          ...diagnostic
        });
        return { diagnostic, payload: void 0 };
      }
      const payload = await response.json();
      logger2?.debug("request.completed", {
        appId,
        durationMs: performance.now() - startedAt,
        source,
        status: response.status,
        url
      });
      return { diagnostic: void 0, payload };
    } catch (error) {
      logger2?.error("request.error", error, {
        appId,
        durationMs: performance.now() - startedAt,
        source,
        url
      });
      return { diagnostic: { error, kind: "exception" }, payload: void 0 };
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
  function getUnresolved(requirements, data, profileFeaturesChecked) {
    const unresolved = [];
    const requiredFields = [
      [requirements.needsPositiveRate, "positiveRate"],
      [requirements.needsReviewCount, "reviewCount"],
      [requirements.needsPrice, "price"],
      [requirements.needsDiscount, "discount"],
      [requirements.needsReleaseDate, "releaseDate"],
      [requirements.needsFreeStatus, "isFree"],
      [requirements.needsDlc, "isDlc"]
    ];
    for (const [required, field] of requiredFields) {
      if (required && data[field] === void 0) {
        unresolved.push(field);
      }
    }
    if (requirements.needsSupportedLanguages && data.descriptionHasChinese !== true && data.supportedLanguages === void 0) {
      unresolved.push("supportedLanguages");
    }
    if (profileFeaturesChecked && data.profileFeaturesLimited === void 0) {
      unresolved.push("profileFeaturesLimited");
    }
    return unresolved;
  }
  function createDiscoveryQueueRuleEngine({ getStoreItem, logger: logger2 } = {}) {
    const reviewsCache = /* @__PURE__ */ new Map();
    const detailsCache = /* @__PURE__ */ new Map();
    const profileFeaturesLimitedReader = createProfileFeaturesLimitedReader({
      logger: logger2?.child?.("profile-features") ?? logger2
    });
    function loadCached(cache, appId, url, source) {
      let payloadPromise = cache.get(appId);
      if (!payloadPromise) {
        payloadPromise = loadJson(url, logger2, source, appId);
        cache.set(appId, payloadPromise);
        payloadPromise.then((result) => {
          if (result.payload === void 0 && cache.get(appId) === payloadPromise) {
            cache.delete(appId);
          }
        });
      }
      return payloadPromise;
    }
    async function loadStoreItem(appId, requirements) {
      if (typeof getStoreItem !== "function") {
        return {
          data: {},
          diagnostic: { kind: "unavailable", reason: "reader-missing" }
        };
      }
      try {
        return {
          data: parseStoreItem(await getStoreItem(appId, requirements), appId),
          diagnostic: void 0
        };
      } catch (error) {
        logger2?.error("store-item.error", error, { appId, requirements });
        return { data: {}, diagnostic: { error, kind: "exception" } };
      }
    }
    return {
      async evaluate({ appId, reviews: existingReviews, tags, config }) {
        if (!/^[1-9]\d*$/.test(appId)) {
          throw new TypeError("appId must be a positive integer string");
        }
        if (config?.enabled === false) {
          const result2 = { matched: false, reasons: [], data: createEmptyData() };
          logger2?.info("evaluation.completed", {
            appId,
            config,
            data: result2.data,
            matched: false,
            reasons: [],
            requirements: { enabled: false },
            sourceErrors: [],
            unresolved: []
          });
          return result2;
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
        const requirements = {
          needsDetails,
          needsDiscount,
          needsDlc,
          needsFreeStatus,
          needsPositiveRate,
          needsPrice,
          needsReleaseDate,
          needsReviewCount,
          needsReviews,
          needsSupportedLanguages,
          requiredLanguages
        };
        const storeItemResult = needsReviews || needsDetails || needsSupportedLanguages ? await loadStoreItem(appId, {
          needsReviews,
          needsReleaseDate,
          needsDlc,
          requiredLanguages
        }) : { data: {}, diagnostic: void 0 };
        const storeItem = storeItemResult.data;
        const missingStoreItemReviews = needsPositiveRate && storeItem.positiveRate === void 0 || needsReviewCount && storeItem.reviewCount === void 0;
        const reviewsPromise = missingStoreItemReviews ? loadCached(
          reviewsCache,
          appId,
          `/appreviews/${appId}?json=1&language=all&purchase_type=steam&num_per_page=0`,
          "reviews"
        ) : Promise.resolve({ diagnostic: void 0, payload: void 0 });
        if (missingStoreItemReviews) {
          logger2?.info("fallback.selected", {
            appId,
            missing: [
              needsPositiveRate && storeItem.positiveRate === void 0 ? "positiveRate" : void 0,
              needsReviewCount && storeItem.reviewCount === void 0 ? "reviewCount" : void 0
            ].filter(Boolean),
            source: "reviews"
          });
        }
        const missingStoreItemData = needsPrice && storeItem.price === void 0 || needsDiscount && storeItem.discount === void 0 || needsReleaseDate && storeItem.releaseDate === void 0 || needsFreeStatus && storeItem.isFree === void 0 || needsDlc && storeItem.isDlc === void 0;
        const detailsPromise = missingStoreItemData ? loadCached(
          detailsCache,
          appId,
          `/api/appdetails?appids=${appId}&l=english`,
          "details"
        ) : Promise.resolve({ diagnostic: void 0, payload: void 0 });
        if (missingStoreItemData) {
          logger2?.info("fallback.selected", {
            appId,
            missing: [
              needsPrice && storeItem.price === void 0 ? "price" : void 0,
              needsDiscount && storeItem.discount === void 0 ? "discount" : void 0,
              needsReleaseDate && storeItem.releaseDate === void 0 ? "releaseDate" : void 0,
              needsFreeStatus && storeItem.isFree === void 0 ? "isFree" : void 0,
              needsDlc && storeItem.isDlc === void 0 ? "isDlc" : void 0
            ].filter(Boolean),
            source: "details"
          });
        }
        const [reviewsResult, detailsResult] = await Promise.all([reviewsPromise, detailsPromise]);
        const reviews = parseReviews(reviewsResult.payload);
        const details = parseDetails(detailsResult.payload, appId);
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
          const result2 = { matched: reasons.length > 0, reasons, data };
          const sourceErrors2 = [
            ["store-item", storeItemResult.diagnostic],
            ["reviews", reviewsResult.diagnostic],
            ["details", detailsResult.diagnostic]
          ].filter(([, diagnostic]) => diagnostic !== void 0).map(([source, diagnostic]) => ({ source, ...diagnostic }));
          logger2?.info("evaluation.completed", {
            appId,
            config,
            data,
            matched: result2.matched,
            reasons: [...reasons],
            requirements,
            sourceErrors: sourceErrors2,
            unresolved: getUnresolved(requirements, data, false)
          });
          return result2;
        }
        const profileFeaturesLimited = await profileFeaturesLimitedReader.get(appId);
        const profileDiagnostic = profileFeaturesLimitedReader.getDiagnostic(appId);
        if (typeof profileFeaturesLimited === "boolean") {
          data.profileFeaturesLimited = profileFeaturesLimited;
        }
        if (profileFeaturesLimited === true) {
          reasons.push("profile-features-limited");
        }
        const result = { matched: reasons.length > 0, reasons, data };
        const sourceErrors = [
          ["store-item", storeItemResult.diagnostic],
          ["reviews", reviewsResult.diagnostic],
          ["details", detailsResult.diagnostic],
          ["profile-features", profileDiagnostic]
        ].filter(([, diagnostic]) => diagnostic !== void 0).map(([source, diagnostic]) => ({ source, ...diagnostic }));
        logger2?.info("evaluation.completed", {
          appId,
          config,
          data,
          matched: result.matched,
          reasons: [...reasons],
          requirements,
          sourceErrors,
          unresolved: getUnresolved(requirements, data, true)
        });
        return result;
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
  function getAppId(url, logger2) {
    try {
      return new URL(url, location.href).pathname.match(/^\/app\/(\d+)(?:\/|$)/)?.[1];
    } catch (error) {
      logger2?.error("context.app_url_parse_failed", error, { url });
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
  function getModalQueueAction(target, logger2) {
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
      appId: getAppId(appLink.href, logger2),
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
  function getModalContext(logger2) {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    for (const dialog of dialogs) {
      const queueLink = dialog.querySelector('a[href*="/explore"][href*="dq=widget"]');
      const header = queueLink?.parentElement?.parentElement;
      if (!(header instanceof HTMLElement)) {
        continue;
      }
      const dialogRect = dialog.getBoundingClientRect();
      const candidates = [...dialog.querySelectorAll("[aria-label]")].map((element) => getModalQueueAction(element, logger2)).filter((action) => action?.action === "ignore" && action.appId).filter(({ button }) => {
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
    const dialogRect = dialog.getBoundingClientRect();
    const summaryRect = summaryCard.getBoundingClientRect();
    const dialogCenter = dialogRect.left + dialogRect.width / 2;
    if (!isVisible(summaryCard) || summaryRect.left > dialogCenter || summaryRect.right < dialogCenter) {
      return void 0;
    }
    const actions = [...actionParent.children].filter(
      (element) => element instanceof HTMLElement && isVisible(element)
    );
    return actions.length === 2 ? actions[1] : void 0;
  }
  function getClassicContinueLink(logger2) {
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
      } catch (error) {
        logger2?.error("auto_continue.url_parse_failed", error, { href: link.href });
        return false;
      }
    });
  }
  function startDiscoveryQueueAutoFilter({ getStoreItem, logger: logger2 } = {}) {
    const autoLogger = logger2?.child("auto-filter");
    const ruleEngine = createDiscoveryQueueRuleEngine({ getStoreItem });
    const continuedModalButtons = /* @__PURE__ */ new WeakSet();
    const continuedClassicLinks = /* @__PURE__ */ new WeakSet();
    const loggedModalSuppressions = /* @__PURE__ */ new WeakSet();
    const loggedClassicSuppressions = /* @__PURE__ */ new WeakSet();
    const modalContinueActionIds = /* @__PURE__ */ new WeakMap();
    const classicContinueActionIds = /* @__PURE__ */ new WeakMap();
    let stopped = false;
    let paused = false;
    let scheduled = false;
    let generation = 0;
    let evaluatedKey;
    let observedContextKey;
    let activeConfig;
    const configUi = createDiscoveryQueueConfigUi({
      logger: autoLogger,
      onSave() {
        activeConfig = configUi.getConfig();
        generation += 1;
        evaluatedKey = void 0;
        autoLogger?.info("config.saved", {
          autoContinueQueue: activeConfig.autoContinueQueue,
          enabled: activeConfig.enabled,
          generation
        });
        schedule();
      },
      onOpenChange(open) {
        paused = open;
        autoLogger?.info("config.pause_changed", { paused });
        if (!open) {
          schedule();
        }
      }
    });
    activeConfig = configUi.getConfig();
    function getContext() {
      return getModalContext(autoLogger) ?? getClassicContext();
    }
    async function evaluateCurrent() {
      scheduled = false;
      const config = activeConfig ?? configUi.getConfig();
      if (paused) {
        autoLogger?.debug("evaluation.skipped", { reason: "config-open" });
        return;
      }
      if (config.autoContinueQueue) {
        const modalContinueButton = getModalContinueButton();
        if (modalContinueButton instanceof HTMLElement && !continuedModalButtons.has(modalContinueButton)) {
          const actionId = autoLogger?.nextId("auto-continue");
          continuedModalButtons.add(modalContinueButton);
          modalContinueActionIds.set(modalContinueButton, actionId);
          autoLogger?.info("auto_continue.clicked", { actionId, mode: "modal" });
          modalContinueButton.click();
          return;
        } else if (modalContinueButton instanceof HTMLElement && !loggedModalSuppressions.has(modalContinueButton)) {
          loggedModalSuppressions.add(modalContinueButton);
          autoLogger?.debug("auto_continue.duplicate_suppressed", {
            actionId: modalContinueActionIds.get(modalContinueButton),
            mode: "modal"
          });
        }
        const classicContinueLink = getClassicContinueLink(autoLogger);
        if (classicContinueLink instanceof HTMLAnchorElement && !continuedClassicLinks.has(classicContinueLink)) {
          const actionId = autoLogger?.nextId("auto-continue");
          continuedClassicLinks.add(classicContinueLink);
          classicContinueActionIds.set(classicContinueLink, actionId);
          autoLogger?.info("auto_continue.clicked", { actionId, mode: "classic" });
          classicContinueLink.click();
          return;
        } else if (classicContinueLink instanceof HTMLAnchorElement && !loggedClassicSuppressions.has(classicContinueLink)) {
          loggedClassicSuppressions.add(classicContinueLink);
          autoLogger?.debug("auto_continue.duplicate_suppressed", {
            actionId: classicContinueActionIds.get(classicContinueLink),
            mode: "classic"
          });
        }
      }
      const context = getContext();
      if (!context) {
        return;
      }
      if (context.key !== observedContextKey) {
        autoLogger?.info("context.changed", {
          appId: context.appId,
          from: observedContextKey,
          mode: context.key?.split(":", 1)[0],
          to: context.key
        });
        observedContextKey = context.key;
      }
      configUi.ensureButton(context.buttonHost);
      if (!config.enabled || !context.appId || context.key === evaluatedKey) {
        return;
      }
      evaluatedKey = context.key;
      const currentGeneration = ++generation;
      const evaluationId = autoLogger?.nextId("evaluation");
      autoLogger?.info("evaluation.started", {
        appId: context.appId,
        evaluationId,
        generation: currentGeneration,
        key: context.key
      });
      let result;
      try {
        result = await ruleEngine.evaluate({
          appId: context.appId,
          reviews: context.reviews,
          tags: context.tags,
          config
        });
        autoLogger?.info("evaluation.completed", {
          appId: context.appId,
          evaluationId,
          matched: result.matched,
          result
        });
      } catch (error) {
        autoLogger?.error("evaluation.failed", error, {
          appId: context.appId,
          evaluationId,
          generation: currentGeneration
        });
        return;
      }
      if (stopped || paused || currentGeneration !== generation) {
        autoLogger?.info("evaluation.stale", {
          currentGeneration: generation,
          evaluationGeneration: currentGeneration,
          evaluationId,
          paused,
          stopped
        });
        return;
      }
      if (!result.matched) {
        return;
      }
      const current = getContext();
      if (current?.key === context.key && current.ignoreButton instanceof HTMLElement) {
        autoLogger?.info("evaluation.ignore_clicked", {
          appId: context.appId,
          evaluationId,
          key: context.key
        });
        current.ignoreButton.click();
      } else {
        autoLogger?.info("evaluation.context_changed_before_action", {
          appId: context.appId,
          currentKey: current?.key,
          evaluationId,
          expectedKey: context.key
        });
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
    autoLogger?.info("controller.started", { enabled: activeConfig.enabled });
    return () => {
      stopped = true;
      generation += 1;
      observer.disconnect();
      configUi.destroy();
      ruleEngine.clear();
      autoLogger?.info("controller.stopped");
    };
  }

  // src/lib/steam/discovery-queue-prefilter.js
  var DISCOVERY_QUEUE_URL = "https://api.steampowered.com/IStoreService/GetDiscoveryQueue/v1";
  var DISCOVERY_QUEUE_DIALOG_SELECTOR = '[role="dialog"]:has(a[href*="/explore"][href*="dq=widget"])';
  var PERMIT_DURATION_MS = 1e4;
  var PREFILTER_CONCURRENCY = 4;
  var DISCOVERY_QUEUE_SUMMARY_APP_ID = 1;
  var POLL_INTERVAL_MS = 50;
  function readVarint(bytes, offset) {
    let value = 0;
    let shift = 0;
    for (let index = 0; index < 10; index += 1) {
      const byte = bytes[offset + index];
      if (byte === void 0) {
        return void 0;
      }
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) {
        return Number.isSafeInteger(value) ? { value, offset: offset + index + 1 } : void 0;
      }
      shift += 7;
    }
    return void 0;
  }
  function skipField(bytes, wireType, offset) {
    if (wireType === 0) {
      return readVarint(bytes, offset)?.offset;
    }
    if (wireType === 1) {
      return offset + 8 <= bytes.length ? offset + 8 : void 0;
    }
    if (wireType === 2) {
      const length = readVarint(bytes, offset);
      return length && length.value <= bytes.length - length.offset ? length.offset + length.value : void 0;
    }
    if (wireType === 5) {
      return offset + 4 <= bytes.length ? offset + 4 : void 0;
    }
    return void 0;
  }
  function decodeBase64(value) {
    if (typeof value !== "string" || !value) {
      return void 0;
    }
    try {
      const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(normalized);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
      return void 0;
    }
  }
  function encodeBase64(bytes) {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }
  function readFields(bytes) {
    const fields = [];
    for (let offset = 0; offset < bytes.length; ) {
      const start = offset;
      const key = readVarint(bytes, offset);
      if (!key || key.value === 0) {
        return void 0;
      }
      offset = key.offset;
      const fieldNumber = Math.floor(key.value / 8);
      const wireType = key.value % 8;
      const end = skipField(bytes, wireType, offset);
      if (end === void 0) {
        return void 0;
      }
      fields.push({ start, keyEnd: offset, end, fieldNumber, wireType });
      offset = end;
    }
    return fields;
  }
  function parseDiscoveryQueueRequest(inputProtobufEncoded) {
    const bytes = decodeBase64(inputProtobufEncoded);
    const fields = bytes && readFields(bytes);
    if (!bytes || !fields) {
      return void 0;
    }
    let queueType;
    let rebuildQueue = false;
    for (const field of fields) {
      if ((field.fieldNumber === 1 || field.fieldNumber === 3) && field.wireType === 0) {
        const value = readVarint(bytes, field.keyEnd);
        if (!value || value.offset !== field.end) {
          return void 0;
        }
        if (field.fieldNumber === 1) {
          queueType = value.value;
        } else {
          rebuildQueue = value.value !== 0;
        }
      }
    }
    return {
      bytes,
      fields,
      standard: queueType === void 0 || queueType === 0,
      rebuild: rebuildQueue
    };
  }
  function decodeDiscoveryQueueAppIds(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : void 0;
    if (!bytes) {
      return void 0;
    }
    const appIds = [];
    for (let offset = 0; offset < bytes.length; ) {
      const key = readVarint(bytes, offset);
      if (!key || key.value === 0) {
        return void 0;
      }
      offset = key.offset;
      const fieldNumber = Math.floor(key.value / 8);
      const wireType = key.value % 8;
      if (fieldNumber === 1 && wireType === 0) {
        const value = readVarint(bytes, offset);
        if (!value || value.value < 1) {
          return void 0;
        }
        appIds.push(value.value);
        offset = value.offset;
        continue;
      }
      if (fieldNumber === 1 && wireType === 2) {
        const length = readVarint(bytes, offset);
        if (!length || length.value > bytes.length - length.offset) {
          return void 0;
        }
        const end = length.offset + length.value;
        offset = length.offset;
        while (offset < end) {
          const value = readVarint(bytes, offset);
          if (!value || value.offset > end || value.value < 1) {
            return void 0;
          }
          appIds.push(value.value);
          offset = value.offset;
        }
        continue;
      }
      const nextOffset = skipField(bytes, wireType, offset);
      if (nextOffset === void 0) {
        return void 0;
      }
      offset = nextOffset;
    }
    return appIds;
  }
  function withDiscoveryQueueRebuild(inputProtobufEncoded) {
    const request = parseDiscoveryQueueRequest(inputProtobufEncoded);
    if (!request?.standard) {
      return void 0;
    }
    const output = [];
    let inserted = false;
    for (const field of request.fields) {
      if (field.fieldNumber === 3 && field.wireType === 0) {
        if (!inserted) {
          output.push(24, 1);
          inserted = true;
        }
      } else {
        output.push(...request.bytes.subarray(field.start, field.end));
      }
    }
    if (!inserted) {
      output.push(24, 1);
    }
    return encodeBase64(Uint8Array.from(output));
  }
  function appIdKey(appIds) {
    if (!Array.isArray(appIds) || appIds.some((appId) => !Number.isSafeInteger(appId) || appId < 1)) {
      return void 0;
    }
    return appIds.join(",");
  }
  function getFetchRequest(input, init) {
    const request = typeof Request === "function" && input instanceof Request ? input : void 0;
    const method = init?.method ?? request?.method ?? "GET";
    if (typeof method !== "string" || method.toUpperCase() !== "GET") {
      return void 0;
    }
    try {
      const url = new URL(request?.url ?? String(input), location.href);
      const pathname = url.pathname.replace(/\/+$/, "");
      if (`${url.origin}${pathname}` !== DISCOVERY_QUEUE_URL) {
        return void 0;
      }
      const encoded = url.searchParams.get("input_protobuf_encoded");
      const queueRequest = parseDiscoveryQueueRequest(encoded);
      return queueRequest ? { url, encoded, queueRequest } : void 0;
    } catch {
      return void 0;
    }
  }
  function createRebuildFetchArgs(args, request) {
    const encoded = withDiscoveryQueueRebuild(request.encoded);
    if (!encoded) {
      return void 0;
    }
    const url = new URL(request.url);
    url.searchParams.set("input_protobuf_encoded", encoded);
    const input = args[0];
    if (typeof Request === "function" && input instanceof Request) {
      return [new Request(url.href, input), args[1]];
    }
    if (input instanceof URL) {
      return [url, args[1]];
    }
    return [url.href, args[1]];
  }
  function isOctetStream(response) {
    const contentType = response.headers?.get("content-type");
    return typeof contentType === "string" && contentType.split(";", 1)[0].trim().toLowerCase() === "application/octet-stream";
  }
  function readSnr() {
    try {
      const config = document.querySelector("#application_config[data-config]")?.dataset.config;
      const snr = config ? JSON.parse(config).SNR : void 0;
      return typeof snr === "string" && snr ? snr : void 0;
    } catch {
      return void 0;
    }
  }
  async function runWithConcurrency(values, worker) {
    let nextIndex = 0;
    const results = new Array(values.length);
    async function consume() {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(values[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(PREFILTER_CONCURRENCY, values.length) }, consume));
    return results;
  }
  function hasActiveRules(config) {
    return Boolean(
      config?.minimumPositiveRate?.enabled || config?.minimumReviewCount?.enabled || config?.maximumPrice?.enabled || config?.minimumDiscount?.enabled || config?.earliestReleaseDate?.enabled || config?.ignoreFree || config?.ignoreUnreviewed || config?.ignoreDlc || config?.ignoreProfileFeaturesLimited || config?.excludedTags?.enabled || config?.requiredLanguages?.enabled
    );
  }
  function getDiscoveryQueueDialog() {
    const dialog = document.querySelector(DISCOVERY_QUEUE_DIALOG_SELECTOR);
    return dialog instanceof HTMLElement ? dialog : void 0;
  }
  function createPrefilterReporter(logger2, lifecycleId) {
    let checked = 0;
    let ignored = 0;
    let total = 0;
    let batches = 0;
    let element;
    let closed = false;
    function ensureElement() {
      if (closed) {
        return void 0;
      }
      if (element?.isConnected) {
        return element;
      }
      if (!(document.body instanceof HTMLElement)) {
        return void 0;
      }
      element = document.createElement("div");
      element.style.cssText = [
        "position:fixed",
        "top:72px",
        "right:24px",
        "z-index:100000",
        "max-width:360px",
        "padding:12px 16px",
        "border:1px solid rgba(103,193,245,.45)",
        "border-radius:4px",
        "background:rgba(20,30,40,.96)",
        "box-shadow:0 8px 24px rgba(0,0,0,.35)",
        "color:#d6d7d8",
        "font:14px/1.5 Arial,sans-serif",
        "pointer-events:none"
      ].join(";");
      document.body.append(element);
      return element;
    }
    function render(stage) {
      const target = ensureElement();
      if (target) {
        target.textContent = `${stage} · 已检查 ${checked}/${total}，已忽略 ${ignored}`;
      }
    }
    return {
      beginBatch(appIds) {
        batches += 1;
        total += appIds.length;
        render(`正在加载第 ${batches} 批（${appIds.length} 项）`);
        logger2?.info("batch.started", {
          appIds: [...appIds],
          batch: batches,
          lifecycleId
        });
      },
      beginEvaluation() {
        render(`正在筛选第 ${batches} 批`);
      },
      recordEvaluation(appId, result) {
        checked += 1;
        render(`正在筛选第 ${batches} 批`);
        if (result?.matched === true) {
          logger2?.info("app.matched", {
            appId,
            lifecycleId,
            reasons: result.reasons
          });
        }
      },
      recordIgnore(appId, succeeded) {
        if (succeeded) {
          ignored += 1;
          render(`正在忽略第 ${batches} 批命中项`);
          logger2?.info("ignore.succeeded", { appId, lifecycleId });
        } else {
          logger2?.warn("ignore.failed", {
            appId,
            lifecycleId
          });
        }
      },
      finishBatch(retainedAppIds, matchedAppIds) {
        logger2?.info("batch.partitioned", {
          batch: batches,
          checked,
          ignored,
          lifecycleId,
          matchedAppIds: [...matchedAppIds],
          retainedAppIds: [...retainedAppIds]
        });
      },
      close() {
        closed = true;
        element?.remove();
        element = void 0;
      }
    };
  }
  function isDiscoveryQueueDataRequest(value) {
    return Boolean(
      value?.include_assets === true && value?.include_trailers === true && value?.include_basic_info === true && value?.include_tag_count === 20 && value?.include_release === true && value?.include_platforms === true && value?.include_screenshots === true && value?.include_reviews === true
    );
  }
  function startDiscoveryQueuePrefilter({
    getStoreItem,
    getLocalizedTags,
    logger: logger2,
    prepareStoreItems
  } = {}) {
    if (typeof window !== "object" || typeof window.fetch !== "function") {
      return () => {
      };
    }
    const lifecycleId = logger2?.nextId?.("prefilter") ?? "prefilter";
    const prefilterLogger = logger2?.child?.("prefilter", { lifecycleId }) ?? logger2;
    const permits = /* @__PURE__ */ new Map();
    const deliveredDialogs = /* @__PURE__ */ new WeakSet();
    const ruleEngine = createDiscoveryQueueRuleEngine({
      getStoreItem,
      logger: prefilterLogger?.child?.("rules", { lifecycleId }) ?? prefilterLogger
    });
    const originalFetch = window.fetch;
    let stopped = false;
    let generation = 0;
    let pollTimer;
    let queueCache;
    let originalQueueMultiple;
    let queueMultipleWrapper;
    prefilterLogger?.info("lifecycle.started", { lifecycleId });
    function grantPermit(appIds, request, args, receiver) {
      const key = appIdKey(appIds);
      if (key !== void 0 && appIds.length > 0) {
        permits.set(key, {
          args,
          expiresAt: Date.now() + PERMIT_DURATION_MS,
          receiver,
          request
        });
        prefilterLogger?.debug("permit.granted", {
          appIds: [...appIds],
          expiresInMs: PERMIT_DURATION_MS,
          lifecycleId,
          rebuild: request.queueRequest.rebuild
        });
      }
    }
    function takePermit(appIds) {
      const key = appIdKey(appIds);
      if (key === void 0) {
        return void 0;
      }
      const permit = permits.get(key);
      permits.delete(key);
      const valid = permit?.expiresAt >= Date.now();
      prefilterLogger?.debug("permit.taken", {
        appIds: [...appIds],
        lifecycleId,
        result: !permit ? "missing" : valid ? "accepted" : "expired"
      });
      return valid ? permit : void 0;
    }
    async function ignoreApp(appId) {
      if (typeof window.g_sessionID !== "string" || !window.g_sessionID) {
        prefilterLogger?.warn("ignore.skipped", {
          appId,
          lifecycleId,
          reason: "missing-session"
        });
        return false;
      }
      const form = new FormData();
      form.set("sessionid", window.g_sessionID);
      form.set("appid", String(appId));
      form.set("remove", "0");
      const snr = readSnr();
      if (snr !== void 0) {
        form.set("snr", snr);
      }
      form.set("ignore_reason", "0");
      const startedAt = performance.now();
      prefilterLogger?.debug("ignore.request.started", { appId, lifecycleId });
      try {
        const response = await Reflect.apply(originalFetch, window, [
          "/recommended/ignorerecommendation",
          {
            method: "POST",
            body: form
          }
        ]);
        if (!response.ok) {
          prefilterLogger?.warn("ignore.request.http-error", {
            appId,
            durationMs: performance.now() - startedAt,
            lifecycleId,
            status: response.status,
            statusText: response.statusText
          });
          return false;
        }
        let payload;
        try {
          payload = await response.json();
        } catch (error) {
          prefilterLogger?.error("ignore.response.parse-error", error, {
            appId,
            durationMs: performance.now() - startedAt,
            lifecycleId,
            status: response.status
          });
          return false;
        }
        const succeeded = payload?.success === true || payload?.success === 1;
        const data = {
          appId,
          durationMs: performance.now() - startedAt,
          lifecycleId,
          payload,
          status: response.status
        };
        if (succeeded) {
          prefilterLogger?.debug("ignore.request.completed", data);
        } else {
          prefilterLogger?.warn("ignore.response.rejected", data);
        }
        return succeeded;
      } catch (error) {
        prefilterLogger?.error("ignore.request.error", error, {
          appId,
          durationMs: performance.now() - startedAt,
          lifecycleId
        });
        return false;
      }
    }
    async function prefilter(appIds, config, currentGeneration, reporter) {
      const requiredLanguages = config.requiredLanguages?.enabled === true ? config.requiredLanguages.value : [];
      if (typeof prepareStoreItems === "function") {
        prefilterLogger?.debug("batch.prepare.started", {
          appIds: [...appIds],
          currentGeneration,
          lifecycleId,
          requiredLanguages: [...requiredLanguages]
        });
        try {
          await prepareStoreItems(appIds, requiredLanguages);
          prefilterLogger?.debug("batch.prepare.completed", {
            appIds: [...appIds],
            currentGeneration,
            lifecycleId
          });
        } catch (error) {
          prefilterLogger?.error("batch.prepare.error", error, {
            appIds: [...appIds],
            currentGeneration,
            lifecycleId
          });
          throw error;
        }
      }
      if (stopped || currentGeneration !== generation) {
        prefilterLogger?.info("generation.cancelled", {
          currentGeneration,
          generation,
          lifecycleId,
          stage: "after-prepare",
          stopped
        });
        return void 0;
      }
      reporter?.beginEvaluation();
      const matches = await runWithConcurrency(appIds, async (appId) => {
        let report = { matched: false, reasons: [] };
        try {
          const tags = config.excludedTags?.enabled && typeof getLocalizedTags === "function" ? await getLocalizedTags(String(appId)) : [];
          const result = await ruleEngine.evaluate({
            appId: String(appId),
            tags: Array.isArray(tags) ? tags : [],
            config
          });
          if (!result?.matched || stopped || currentGeneration !== generation) {
            return false;
          }
          report = {
            matched: true,
            reasons: Array.isArray(result.reasons) ? result.reasons : []
          };
          return true;
        } catch (error) {
          prefilterLogger?.error("app.evaluation.error", error, {
            appId,
            currentGeneration,
            lifecycleId
          });
          return false;
        } finally {
          reporter?.recordEvaluation(appId, report);
        }
      });
      if (stopped || currentGeneration !== generation) {
        prefilterLogger?.info("generation.cancelled", {
          currentGeneration,
          generation,
          lifecycleId,
          stage: "after-evaluation",
          stopped
        });
        return void 0;
      }
      const retainedAppIds = appIds.filter((_, index) => matches[index] !== true);
      const matchedAppIds = appIds.filter((_, index) => matches[index] === true);
      reporter?.finishBatch(retainedAppIds, matchedAppIds);
      const ignoreCompletion = runWithConcurrency(matchedAppIds, async (appId) => {
        const succeeded = await ignoreApp(appId);
        reporter?.recordIgnore(appId, succeeded);
        return succeeded;
      });
      prefilterLogger?.info("batch.ignore.deferred", {
        appIds: [...matchedAppIds],
        lifecycleId,
        retainedAppIds: [...retainedAppIds]
      });
      return { ignoreCompletion, retainedAppIds };
    }
    function replaceAppIds(target, replacement) {
      target.splice(0, target.length, ...replacement);
    }
    async function loadNextVisibleBatch(permit, dataRequest, queueReceiver, config, currentGeneration, seenBatches, reporter) {
      let fetchArgs = createRebuildFetchArgs(permit.args, permit.request);
      if (!fetchArgs) {
        prefilterLogger?.warn("summary.selected", {
          lifecycleId,
          reason: "rebuild-request-unavailable"
        });
        return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
      }
      while (!stopped && currentGeneration === generation) {
        let response;
        try {
          response = await Reflect.apply(originalFetch, permit.receiver, fetchArgs);
        } catch (error) {
          prefilterLogger?.error("rebuild.request.error", error, { lifecycleId });
          prefilterLogger?.warn("summary.selected", {
            lifecycleId,
            reason: "rebuild-request-error"
          });
          return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
        }
        if (!response?.ok || !isOctetStream(response)) {
          prefilterLogger?.warn("summary.selected", {
            contentType: response?.headers?.get?.("content-type"),
            lifecycleId,
            reason: "rebuild-invalid-response",
            status: response?.status
          });
          return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
        }
        let appIds;
        try {
          appIds = decodeDiscoveryQueueAppIds(await response.clone().arrayBuffer());
        } catch (error) {
          prefilterLogger?.error("rebuild.response.decode-error", error, {
            lifecycleId,
            status: response.status
          });
          prefilterLogger?.warn("summary.selected", {
            lifecycleId,
            reason: "rebuild-decode-error"
          });
          return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
        }
        const key = appIdKey(appIds);
        if (!appIds || appIds.length === 0 || key === void 0 || seenBatches.has(key)) {
          prefilterLogger?.warn("summary.selected", {
            appIds,
            lifecycleId,
            reason: !appIds ? "rebuild-invalid-appids" : appIds.length === 0 ? "queue-exhausted" : key === void 0 ? "rebuild-invalid-appid-key" : "rebuild-repeated-batch"
          });
          return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
        }
        seenBatches.add(key);
        reporter?.beginBatch(appIds);
        try {
          await Reflect.apply(originalQueueMultiple, queueReceiver, [appIds, dataRequest]);
        } catch (error) {
          prefilterLogger?.error("rebuild.store-items.error", error, {
            appIds: [...appIds],
            lifecycleId
          });
          prefilterLogger?.warn("summary.selected", {
            lifecycleId,
            reason: "rebuild-store-items-error"
          });
          return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
        }
        const filteredBatch = await prefilter(
          appIds,
          config,
          currentGeneration,
          reporter
        );
        if (!filteredBatch) {
          prefilterLogger?.info("display.original-batch", {
            appIds: [...appIds],
            lifecycleId,
            reason: "generation-cancelled"
          });
          return appIds;
        }
        if (filteredBatch.retainedAppIds.length > 0) {
          prefilterLogger?.info("display.retained", {
            appIds: [...filteredBatch.retainedAppIds],
            lifecycleId,
            source: "rebuild"
          });
          return filteredBatch.retainedAppIds;
        }
        prefilterLogger?.info("rebuild.next-batch", {
          lifecycleId,
          reason: "batch-fully-filtered"
        });
        await filteredBatch.ignoreCompletion;
      }
      return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
    }
    function wrappedFetch(...args) {
      const responsePromise = Reflect.apply(originalFetch, this, args);
      let request;
      try {
        request = getFetchRequest(args[0], args[1]);
      } catch (error) {
        prefilterLogger?.error("fetch.intercept.parse-error", error, { lifecycleId });
        return responsePromise;
      }
      if (!request?.queueRequest.standard) {
        return responsePromise;
      }
      const receiver = this;
      return Promise.resolve(responsePromise).then(async (response) => {
        if (stopped || !response?.ok || !isOctetStream(response)) {
          return response;
        }
        try {
          const appIds = decodeDiscoveryQueueAppIds(await response.clone().arrayBuffer());
          if (!stopped && appIds) {
            grantPermit(appIds, request, args, receiver);
          }
        } catch (error) {
          prefilterLogger?.error("fetch.response.decode-error", error, {
            lifecycleId,
            status: response.status
          });
          return response;
        }
        return response;
      });
    }
    function installQueueWrapper() {
      if (stopped) {
        return;
      }
      const cache = window.StoreItemCache;
      const current = cache?.QueueMultipleAppRequests;
      if (cache && typeof current === "function" && current !== queueMultipleWrapper) {
        queueCache = cache;
        originalQueueMultiple = current;
        queueMultipleWrapper = function wrappedQueueMultiple(appIds, ...args) {
          const result = Reflect.apply(originalQueueMultiple, this, [appIds, ...args]);
          const snapshot = Array.isArray(appIds) ? [...appIds] : void 0;
          const expectedKey = snapshot && appIdKey(snapshot);
          const dialog = getDiscoveryQueueDialog();
          if (expectedKey === void 0 || snapshot.length === 0 || !dialog || !isDiscoveryQueueDataRequest(args[0])) {
            if (expectedKey !== void 0 && snapshot.length > 0) {
              prefilterLogger?.debug("queue.intercept.skipped", {
                appIds: snapshot,
                hasDialog: Boolean(dialog),
                isDiscoveryQueueDataRequest: isDiscoveryQueueDataRequest(args[0]),
                lifecycleId,
                reason: !dialog ? "dialog-missing" : "data-request-mismatch"
              });
            }
            return result;
          }
          const permit = takePermit(snapshot);
          if (deliveredDialogs.has(dialog) && !permit?.request.queueRequest.rebuild) {
            prefilterLogger?.info("queue.intercept.skipped", {
              appIds: snapshot,
              lifecycleId,
              reason: "dialog-already-delivered"
            });
            return result;
          }
          deliveredDialogs.add(dialog);
          let config;
          try {
            config = loadDiscoveryQueueConfig(
              prefilterLogger?.child?.("config", { lifecycleId }) ?? prefilterLogger
            );
          } catch (error) {
            prefilterLogger?.error("config.load.error", error, { lifecycleId });
            return result;
          }
          if (config?.enabled !== true || !hasActiveRules(config)) {
            prefilterLogger?.info("queue.intercept.skipped", {
              appIds: snapshot,
              lifecycleId,
              reason: config?.enabled !== true ? "disabled" : "no-active-rules"
            });
            return result;
          }
          const currentGeneration = generation;
          const queueReceiver = this;
          const reporter = createPrefilterReporter(prefilterLogger, lifecycleId);
          prefilterLogger?.info("queue.intercepted", {
            appIds: snapshot,
            generation: currentGeneration,
            hasPermit: Boolean(permit),
            lifecycleId
          });
          reporter.beginBatch(snapshot);
          return Promise.resolve(result).then(async (value) => {
            const filteredBatch = await prefilter(
              snapshot,
              config,
              currentGeneration,
              reporter
            );
            if (!filteredBatch || stopped || currentGeneration !== generation) {
              prefilterLogger?.info("display.original-batch", {
                appIds: snapshot,
                lifecycleId,
                reason: "generation-cancelled"
              });
              return value;
            }
            if (filteredBatch.retainedAppIds.length > 0) {
              replaceAppIds(appIds, filteredBatch.retainedAppIds);
              prefilterLogger?.info("display.retained", {
                appIds: [...filteredBatch.retainedAppIds],
                lifecycleId,
                source: "initial"
              });
              return value;
            }
            await filteredBatch.ignoreCompletion;
            if (stopped || currentGeneration !== generation) {
              return value;
            }
            if (!permit) {
              prefilterLogger?.warn("summary.selected", {
                lifecycleId,
                reason: "fully-filtered-without-permit"
              });
              replaceAppIds(appIds, [DISCOVERY_QUEUE_SUMMARY_APP_ID]);
              return value;
            }
            const nextAppIds = await loadNextVisibleBatch(
              permit,
              args[0],
              queueReceiver,
              config,
              currentGeneration,
              /* @__PURE__ */ new Set([expectedKey]),
              reporter
            );
            replaceAppIds(appIds, nextAppIds);
            return value;
          }).finally(() => reporter.close());
        };
        cache.QueueMultipleAppRequests = queueMultipleWrapper;
      }
      pollTimer = setTimeout(installQueueWrapper, POLL_INTERVAL_MS);
    }
    window.fetch = wrappedFetch;
    installQueueWrapper();
    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      generation += 1;
      prefilterLogger?.info("lifecycle.stopped", { generation, lifecycleId });
      permits.clear();
      clearTimeout(pollTimer);
      ruleEngine.clear();
      if (window.fetch === wrappedFetch) {
        window.fetch = originalFetch;
      }
      if (queueCache?.QueueMultipleAppRequests === queueMultipleWrapper) {
        queueCache.QueueMultipleAppRequests = originalQueueMultiple;
      }
    };
  }

  // src/lib/steam/discovery-queue-tags.js
  var TAG_LIST_URL = "https://api.steampowered.com/IStoreService/GetTagList/v1/";
  var TAG_CACHE_PREFIX = "LocalizedTagNames2_";
  function readSteamLanguage(logger2) {
    try {
      const config = document.querySelector("#application_config[data-config]")?.dataset.config;
      const language = config ? JSON.parse(config).LANGUAGE : void 0;
      if (typeof language === "string" && language) {
        return language;
      }
    } catch (error) {
      logger2?.error("language.config.error", error, {
        fallback: "window-or-html-language"
      });
    }
    if (typeof window.g_strLanguage === "string" && window.g_strLanguage) {
      return window.g_strLanguage;
    }
    const htmlLanguage = document.documentElement?.lang?.toLowerCase();
    if (htmlLanguage === "zh-cn") {
      return "schinese";
    }
    if (htmlLanguage === "zh-tw" || htmlLanguage === "zh-hk") {
      return "tchinese";
    }
    return "english";
  }
  function parseTags(value) {
    if (!Array.isArray(value)) {
      return void 0;
    }
    const tags = [];
    for (const entry of value) {
      const tagId = entry?.tagid;
      const name = entry?.name;
      if (!Number.isSafeInteger(tagId) || tagId < 1 || typeof name !== "string" || !name.trim()) {
        return void 0;
      }
      tags.push([tagId, name.trim()]);
    }
    return tags;
  }
  function readCachedTags(language, logger2) {
    try {
      const value = JSON.parse(
        localStorage.getItem(`${TAG_CACHE_PREFIX}${language}`) ?? "null"
      );
      const tags = parseTags(value?.tags);
      return tags ? { tags, versionHash: String(value.version_hash ?? "") } : void 0;
    } catch (error) {
      logger2?.error("cache.read.error", error, { language });
      return void 0;
    }
  }
  function saveCachedTags(language, value, logger2) {
    try {
      localStorage.setItem(
        `${TAG_CACHE_PREFIX}${language}`,
        JSON.stringify({
          tags: value.tags.map(([tagid, name]) => ({ tagid, name })),
          version_hash: value.versionHash
        })
      );
    } catch (error) {
      logger2?.error("cache.write.error", error, {
        language,
        tagCount: value.tags.length
      });
      return false;
    }
    return true;
  }
  async function loadTagNames(language, logger2) {
    const cached = readCachedTags(language, logger2);
    if (cached) {
      logger2?.debug("catalog.cache-hit", {
        language,
        tagCount: cached.tags.length,
        versionHash: cached.versionHash
      });
      return new Map(cached.tags);
    }
    const url = new URL(TAG_LIST_URL);
    url.searchParams.set("language", language);
    url.searchParams.set("origin", location.origin);
    const startedAt = performance.now();
    logger2?.info("catalog.request.started", { language, url: url.href });
    try {
      const response = await fetch(url);
      if (!response.ok) {
        logger2?.warn("catalog.request.http-error", {
          durationMs: performance.now() - startedAt,
          language,
          status: response.status,
          statusText: response.statusText,
          url: url.href
        });
        return /* @__PURE__ */ new Map();
      }
      const payload = (await response.json())?.response;
      const tags = parseTags(payload?.tags);
      if (tags) {
        const value = {
          tags,
          versionHash: String(payload.version_hash ?? "")
        };
        const persisted = saveCachedTags(language, value, logger2);
        logger2?.info("catalog.request.completed", {
          durationMs: performance.now() - startedAt,
          language,
          persisted,
          status: response.status,
          tagCount: tags.length,
          url: url.href,
          versionHash: value.versionHash
        });
        return new Map(tags);
      }
      logger2?.warn("catalog.response.invalid", {
        durationMs: performance.now() - startedAt,
        language,
        status: response.status,
        url: url.href
      });
    } catch (error) {
      logger2?.error("catalog.request.error", error, {
        durationMs: performance.now() - startedAt,
        language,
        url: url.href
      });
      return /* @__PURE__ */ new Map();
    }
    return /* @__PURE__ */ new Map();
  }
  function createDiscoveryQueueTagCatalog({ logger: logger2 } = {}) {
    const catalogs = /* @__PURE__ */ new Map();
    return {
      async getNames(tagIds) {
        if (!Array.isArray(tagIds) || tagIds.length === 0) {
          return [];
        }
        const language = readSteamLanguage(logger2);
        let catalogPromise = catalogs.get(language);
        if (!catalogPromise) {
          catalogPromise = loadTagNames(language, logger2);
          catalogs.set(language, catalogPromise);
        }
        const catalog = await catalogPromise;
        return tagIds.map((tagId) => catalog.get(tagId)).filter((name) => typeof name === "string");
      },
      clear() {
        catalogs.clear();
      }
    };
  }

  // src/lib/steam/discovery-queue-store-items.js
  var CACHE_WAIT_MS = 50;
  var CHINESE_LANGUAGE_IDS = /* @__PURE__ */ new Set([6, 7, 29]);
  var DLC_APP_TYPE = 4;
  var SUPPORTED_LANGUAGES_REQUEST = { include_supported_languages: true };
  function getStoreItemCache() {
    const cache = window.StoreItemCache;
    return cache && typeof cache.GetApp === "function" && typeof cache.QueueAppRequest === "function" ? cache : void 0;
  }
  async function waitForStoreItemCache(logger2) {
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
    logger2?.warn("cache.unavailable", { waitedMs: CACHE_WAIT_MS });
    return void 0;
  }
  function toSafeNonNegativeInteger(value) {
    const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(number) && number >= 0 ? number : void 0;
  }
  function readArray(getter, logger2, field, appId) {
    try {
      const value = getter();
      return Array.isArray(value) ? value.filter((entry) => Number.isSafeInteger(entry) && entry > 0) : [];
    } catch (error) {
      logger2?.error("item.read.error", error, { appId, field });
      return [];
    }
  }
  function readSupportedLanguages(item, logger2, appId) {
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
    } catch (error) {
      logger2?.error("item.read.error", error, {
        appId,
        field: "supportedLanguages"
      });
      return void 0;
    }
  }
  function readDescriptionHasChinese(item, logger2, appId) {
    if (typeof item.GetShortDescription !== "function") {
      return void 0;
    }
    try {
      const description = item.GetShortDescription();
      return typeof description === "string" ? /\p{Script=Han}/u.test(description) : void 0;
    } catch (error) {
      logger2?.error("item.read.error", error, {
        appId,
        field: "descriptionHasChinese"
      });
      return void 0;
    }
  }
  function readAppType(item, logger2, appId) {
    if (typeof item?.GetAppType !== "function") {
      return void 0;
    }
    try {
      const appType = item.GetAppType();
      return Number.isSafeInteger(appType) && appType >= 0 ? appType : void 0;
    } catch (error) {
      logger2?.error("item.read.error", error, { appId, field: "appType" });
      return void 0;
    }
  }
  function buildStoreItemRequest(requirements, appType) {
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
    return request;
  }
  function readReviewSummary(item, logger2, appId) {
    const preferUnfiltered = window.GDynamicStore?.s_preferences?.review_score_preference === 1;
    const summaryGetter = preferUnfiltered ? item.GetUnfilteredReviewSummary : item.GetFilteredReviewSummary;
    let summary;
    try {
      summary = summaryGetter?.call(item);
    } catch (error) {
      logger2?.error("item.read.error", error, {
        appId,
        field: "reviewSummary"
      });
      return {};
    }
    const reviewCount = toSafeNonNegativeInteger(summary?.review_count);
    const positiveRate = summary?.percent_positive;
    return {
      reviewCount,
      positiveRate: reviewCount !== 0 && typeof positiveRate === "number" && Number.isFinite(positiveRate) && positiveRate >= 0 && positiveRate <= 100 ? positiveRate : void 0
    };
  }
  function readStoreItem(item, appId, logger2) {
    if (!item || typeof item !== "object") {
      return void 0;
    }
    try {
      if (typeof item.GetID === "function" && item.GetID() !== appId) {
        return void 0;
      }
      const purchase = item.GetBestPurchaseOption?.();
      const comingSoon = item.BIsComingSoon?.();
      const appType = readAppType(item, logger2, appId);
      const reviews = readReviewSummary(item, logger2, appId);
      const storeItem = {
        appId,
        success: 1,
        isFree: item.BIsFree?.(),
        comingSoon,
        descriptionHasChinese: readDescriptionHasChinese(item, logger2, appId),
        isDlc: appType === void 0 ? void 0 : appType === DLC_APP_TYPE,
        supportedLanguages: readSupportedLanguages(item, logger2, appId),
        tagIds: readArray(() => item.GetTagIDs?.(), logger2, "tagIds", appId),
        categoryIds: {
          supportedPlayers: readArray(() => item.GetStoreCategories_SupportedPlayers?.(), logger2, "supportedPlayers", appId),
          features: readArray(() => item.GetStoreCategories_Features?.(), logger2, "features", appId),
          controllers: readArray(() => item.GetStoreCategories_Controller?.(), logger2, "controllers", appId)
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
    } catch (error) {
      logger2?.error("item.read.error", error, { appId, field: "storeItem" });
      return void 0;
    }
  }
  function createDiscoveryQueueStoreItemReader({ logger: logger2 } = {}) {
    const tagCatalog = createDiscoveryQueueTagCatalog({
      logger: logger2?.child?.("tags") ?? logger2
    });
    let stopped = false;
    return {
      async prepareBatch(appIds, requiredLanguages) {
        if (stopped || !Array.isArray(appIds) || !Array.isArray(requiredLanguages) || requiredLanguages.length === 0) {
          return;
        }
        const cache = await waitForStoreItemCache(logger2);
        if (!cache || typeof cache.QueueMultipleAppRequests !== "function" || stopped) {
          return;
        }
        const acceptsChineseDescription = requiredLanguages.some(
          (language) => CHINESE_LANGUAGE_IDS.has(language)
        );
        const missingAppIds = appIds.filter((appId) => {
          const item = cache.GetApp(appId);
          return !(acceptsChineseDescription && readDescriptionHasChinese(item, logger2, appId) === true) && !item?.BContainDataRequest?.(SUPPORTED_LANGUAGES_REQUEST);
        });
        if (missingAppIds.length === 0) {
          return;
        }
        const startedAt = performance.now();
        logger2?.info("batch.request.started", {
          appIds: [...missingAppIds],
          request: SUPPORTED_LANGUAGES_REQUEST,
          requiredLanguages: [...requiredLanguages]
        });
        try {
          await cache.QueueMultipleAppRequests(
            missingAppIds,
            SUPPORTED_LANGUAGES_REQUEST
          );
          logger2?.info("batch.request.completed", {
            appIds: [...missingAppIds],
            durationMs: performance.now() - startedAt,
            requiredLanguages: [...requiredLanguages]
          });
        } catch (error) {
          logger2?.error("batch.request.error", error, {
            appIds: [...missingAppIds],
            durationMs: performance.now() - startedAt,
            request: SUPPORTED_LANGUAGES_REQUEST,
            requiredLanguages: [...requiredLanguages]
          });
          return;
        }
      },
      async get(appId, requirements) {
        if (stopped || typeof appId !== "string" || !/^[1-9]\d*$/.test(appId)) {
          return void 0;
        }
        const numericAppId = Number(appId);
        if (!Number.isSafeInteger(numericAppId)) {
          return void 0;
        }
        const cache = await waitForStoreItemCache(logger2);
        if (!cache || stopped) {
          return void 0;
        }
        try {
          let item = cache.GetApp(numericAppId);
          const request = buildStoreItemRequest(
            requirements,
            readAppType(item, logger2, numericAppId)
          );
          if (Object.keys(request).length > 0 && !item?.BContainDataRequest?.(request)) {
            const startedAt = performance.now();
            logger2?.debug("item.request.started", {
              appId: numericAppId,
              request,
              requirements
            });
            await cache.QueueAppRequest(numericAppId, request);
            item = cache.GetApp(numericAppId);
            logger2?.debug("item.request.completed", {
              appId: numericAppId,
              durationMs: performance.now() - startedAt,
              request,
              requirements
            });
          }
          const result = readStoreItem(item, numericAppId, logger2);
          logger2?.debug("item.result", {
            appId: numericAppId,
            requirements,
            result
          });
          return result;
        } catch (error) {
          logger2?.error("item.request.error", error, {
            appId: numericAppId,
            requirements
          });
          return void 0;
        }
      },
      async getLocalizedTags(appId) {
        if (stopped || typeof appId !== "string" || !/^[1-9]\d*$/.test(appId)) {
          return [];
        }
        const numericAppId = Number(appId);
        if (!Number.isSafeInteger(numericAppId)) {
          return [];
        }
        const cache = await waitForStoreItemCache(logger2);
        if (!cache || stopped) {
          return [];
        }
        try {
          const tagIds = readArray(
            () => cache.GetApp(numericAppId)?.GetTagIDs?.(),
            logger2,
            "tagIds",
            numericAppId
          );
          const uniqueTagIds = [...new Set(tagIds)];
          if (uniqueTagIds.length === 0) {
            return [];
          }
          const names = await tagCatalog.getNames(uniqueTagIds);
          logger2?.debug("tags.resolved", {
            appId: numericAppId,
            names,
            tagIds: uniqueTagIds
          });
          return names;
        } catch (error) {
          logger2?.error("tags.resolve.error", error, { appId: numericAppId });
          return [];
        }
      },
      stop() {
        stopped = true;
        tagCatalog.clear();
      }
    };
  }

  // src/lib/steam/discovery-queue.js
  var QUEUE_TIMEOUT_MS = 1e4;
  var ADVANCE_DELAY_MS = 50;
  var CLASSIC_NEXT_SELECTOR = "#nextInDiscoveryQueue .btn_next_in_queue_trigger";
  var MODAL_WISHLIST_PATH = "/api/addtowishlist";
  var MODAL_QUEUE_SELECTOR = '[role="dialog"]:has(a[href*="/explore"][href*="dq=widget"])';
  function isVisible2(element) {
    return Boolean(
      element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden"
    );
  }
  function matchesAction(target, selector) {
    return target instanceof Element && target.closest(selector) !== null;
  }
  function startClassicQueue(logger2) {
    if (new URLSearchParams(location.search).get("queue") !== "1") {
      logger2?.debug("controller.skipped", { reason: "not-classic-queue" });
      return () => {
      };
    }
    const queueActions = document.querySelector("#queueActionsCtn");
    const nextButton = document.querySelector(CLASSIC_NEXT_SELECTOR);
    if (!(queueActions instanceof HTMLElement) || !(nextButton instanceof HTMLElement)) {
      logger2?.debug("controller.skipped", { reason: "controls-not-found" });
      return () => {
      };
    }
    let observer;
    let timer;
    let frame;
    const pendingActions = /* @__PURE__ */ new Set();
    let activeAdvance;
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
    function advance(pending, delay = ADVANCE_DELAY_MS) {
      if (advancing) {
        logger2?.debug("advance.suppressed", {
          actionId: pending?.actionId,
          reason: "already-advancing"
        });
        return;
      }
      stopWaiting();
      advancing = true;
      activeAdvance = pending;
      logger2?.info("advance.scheduled", {
        action: pending?.action,
        actionId: pending?.actionId,
        delay
      });
      timer = setTimeout(() => {
        timer = void 0;
        const triggerNext = () => {
          frame = void 0;
          const currentNextButton = document.querySelector(CLASSIC_NEXT_SELECTOR);
          if (currentNextButton instanceof HTMLElement) {
            currentNextButton.click();
            logger2?.info("advance.clicked", {
              action: pending?.action,
              actionId: pending?.actionId
            });
          } else {
            logger2?.warn("advance.button_missing", {
              action: pending?.action,
              actionId: pending?.actionId
            });
          }
          advancing = false;
          activeAdvance = void 0;
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
      for (const pending of pendingActions) {
        if (hasSucceeded()) {
          logger2?.info("wishlist.succeeded", { actionId: pending.actionId });
          advance(pending);
          return;
        }
        if (hasFailed()) {
          logger2?.warn("wishlist.failed", { actionId: pending.actionId });
          pendingActions.delete(pending);
        }
      }
      if (pendingActions.size === 0) {
        stopWaiting();
      }
    }
    function waitForResult(pending) {
      if (advancing) {
        logger2?.debug("action.suppressed", {
          action: pending.action,
          actionId: pending.actionId,
          reason: "advancing"
        });
        return;
      }
      if ([...pendingActions].some((action) => action.action === pending.action)) {
        logger2?.debug("action.suppressed", {
          action: pending.action,
          actionId: pending.actionId,
          reason: "already-pending"
        });
        return;
      }
      pendingActions.add(pending);
      logger2?.info("wishlist.waiting", { actionId: pending.actionId });
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
      timer = setTimeout(() => {
        for (const action of pendingActions) {
          logger2?.warn("wishlist.timeout", { actionId: action.actionId });
        }
        stopWaiting();
      }, QUEUE_TIMEOUT_MS);
    }
    function handleClick(event) {
      const { target } = event;
      if (matchesAction(target, "#add_to_wishlist_area a.add_to_wishlist")) {
        const pending = {
          action: "wishlist",
          actionId: logger2?.nextId("classic-action")
        };
        logger2?.info("action.clicked", pending);
        waitForResult(pending);
      } else if (matchesAction(target, ".queue_btn_ignore .queue_btn_inactive") || matchesAction(target, "#queue_ignore_menu_option_not_interested") || matchesAction(target, "#queue_ignore_menu_option_owned_elsewhere")) {
        const pending = {
          action: "ignore",
          actionId: logger2?.nextId("classic-action")
        };
        logger2?.info("action.clicked", pending);
        advance(pending, 0);
      }
    }
    function stop() {
      logger2?.info("controller.stopping", {
        advancing,
        pendingCount: pendingActions.size
      });
      if (activeAdvance) {
        logger2?.info("advance.cancelled", {
          action: activeAdvance.action,
          actionId: activeAdvance.actionId,
          reason: "controller-stop"
        });
      }
      for (const pending of pendingActions) {
        logger2?.info("action.cancelled", {
          action: pending.action,
          actionId: pending.actionId,
          reason: "controller-stop"
        });
      }
      stopWaiting();
      activeAdvance = void 0;
      queueActions.removeEventListener("click", handleClick, true);
      window.removeEventListener("pagehide", stop);
    }
    queueActions.addEventListener("click", handleClick, true);
    window.addEventListener("pagehide", stop, { once: true });
    logger2?.info("controller.started");
    return stop;
  }
  function startModalReviewCountFix(logger2) {
    const root = document.body;
    if (!(root instanceof HTMLElement)) {
      return () => {
      };
    }
    function normalize() {
      const dialog = document.querySelector(MODAL_QUEUE_SELECTOR);
      if (!(dialog instanceof HTMLElement)) {
        return;
      }
      for (const element of dialog.querySelectorAll("[aria-label]")) {
        if (element.childElementCount > 0) {
          continue;
        }
        const match = element.textContent?.trim().match(/^\(\((.+)\)\)$/u);
        if (match) {
          const previousText = element.textContent;
          element.textContent = `(${match[1]})`;
          logger2?.info("review_count.corrected", {
            correctedText: element.textContent,
            previousText,
            reviewCount: match[1]
          });
        }
      }
    }
    const observer = new MutationObserver(normalize);
    observer.observe(root, { characterData: true, childList: true, subtree: true });
    normalize();
    return () => observer.disconnect();
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
  function monitorActionRequests(logger2, takePending, handleResult) {
    if (typeof window.fetch !== "function") {
      logger2?.warn("fetch.monitor_unavailable");
      return () => {
      };
    }
    const originalFetch = window.fetch;
    function monitoredFetch(...args) {
      let response;
      try {
        response = Reflect.apply(originalFetch, this, args);
      } catch (error) {
        logger2?.error("fetch.call_failed", error, {
          input: args[0],
          init: args[1]
        });
        throw error;
      }
      let pathname;
      try {
        pathname = getMonitoredPath(args[0], args[1]);
      } catch (error) {
        logger2?.error("fetch.inspect_failed", error, {
          input: args[0],
          init: args[1]
        });
        return response;
      }
      if (!pathname) {
        return response;
      }
      const pending = takePending(pathname);
      if (!pending) {
        logger2?.warn("fetch.pending_missing", { pathname });
        return response;
      }
      logger2?.info("fetch.matched", {
        actionId: pending.actionId,
        pathname
      });
      return response.then(
        (result) => {
          logger2?.info("fetch.completed", {
            actionId: pending.actionId,
            ok: result.ok,
            pathname,
            status: result.status
          });
          handleResult(pending, result.ok);
          return result;
        },
        (error) => {
          logger2?.error("fetch.failed", error, {
            actionId: pending.actionId,
            pathname
          });
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
  function startModalQueue(logger2) {
    const requestQueues = /* @__PURE__ */ new Map();
    const pendingActions = /* @__PURE__ */ new Set();
    let advanceFrame;
    let activeAdvance;
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
        logger2?.debug("advance.suppressed", {
          actionId: pending.actionId,
          reason: "already-advancing"
        });
        return;
      }
      advancing = true;
      activeAdvance = pending;
      clearPending();
      const deadline = performance.now() + QUEUE_TIMEOUT_MS;
      logger2?.info("advance.started", {
        action: pending.action,
        actionId: pending.actionId,
        immediate
      });
      const triggerNext = () => {
        advanceFrame = void 0;
        if (!pending.dialog.isConnected) {
          advancing = false;
          activeAdvance = void 0;
          logger2?.warn("advance.cancelled", {
            actionId: pending.actionId,
            reason: "dialog-disconnected"
          });
          return;
        }
        const nextButton = findModalNextButton(pending.dialog);
        if (nextButton) {
          nextButton.click();
          advancing = false;
          activeAdvance = void 0;
          logger2?.info("advance.clicked", { actionId: pending.actionId });
          return;
        }
        if (performance.now() >= deadline) {
          advancing = false;
          activeAdvance = void 0;
          logger2?.warn("advance.timeout", { actionId: pending.actionId });
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
        if (!pending.selectedStateDetected) {
          pending.selectedStateDetected = true;
          logger2?.debug("selected_state.detected", {
            actionId: pending.actionId
          });
        }
        pending.stabilityTimer = setTimeout(() => {
          if (pending.button.isConnected && pending.button.className !== pending.initialClassName) {
            logger2?.info("selected_state.confirmed", {
              actionId: pending.actionId
            });
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
      logger2,
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
          logger2?.debug("fetch.result_ignored", {
            actionId: pending.actionId,
            reason: "pending-cancelled"
          });
          return;
        }
        if (succeeded) {
          logger2?.info("action.request_succeeded", {
            actionId: pending.actionId
          });
          waitForSelectedState(pending);
        } else {
          logger2?.warn("action.request_failed", {
            actionId: pending.actionId
          });
          removePending(pending);
        }
      }
    );
    function handleClick(event) {
      const modalAction = getModalQueueAction(event.target, logger2);
      if (!modalAction) {
        return;
      }
      modalAction.actionId = logger2?.nextId("modal-action");
      if (advancing) {
        logger2?.debug("action.suppressed", {
          action: modalAction.action,
          actionId: modalAction.actionId,
          appId: modalAction.appId,
          reason: "advancing"
        });
        return;
      }
      logger2?.info("action.clicked", {
        action: modalAction.action,
        actionId: modalAction.actionId,
        appId: modalAction.appId
      });
      if (modalAction.action === "ignore") {
        advance(modalAction, true);
        return;
      }
      const pending = {
        ...modalAction,
        pathname: MODAL_WISHLIST_PATH
      };
      pending.timer = setTimeout(() => {
        logger2?.warn("action.pending_timeout", {
          actionId: pending.actionId,
          pathname: pending.pathname
        });
        removePending(pending);
      }, QUEUE_TIMEOUT_MS);
      pendingActions.add(pending);
      const queue = requestQueues.get(MODAL_WISHLIST_PATH) ?? [];
      queue.push(pending);
      requestQueues.set(MODAL_WISHLIST_PATH, queue);
    }
    function stop() {
      logger2?.info("controller.stopping", {
        advancing,
        pendingCount: pendingActions.size
      });
      if (activeAdvance) {
        logger2?.info("advance.cancelled", {
          actionId: activeAdvance.actionId,
          reason: "controller-stop"
        });
      }
      for (const pending of pendingActions) {
        logger2?.info("action.cancelled", {
          action: pending.action,
          actionId: pending.actionId,
          appId: pending.appId,
          reason: "controller-stop"
        });
      }
      cancelAnimationFrame(advanceFrame);
      advanceFrame = void 0;
      activeAdvance = void 0;
      advancing = false;
      stopMonitoringRequests();
      clearPending();
      document.removeEventListener("click", handleClick, true);
      window.removeEventListener("pagehide", stop);
    }
    document.addEventListener("click", handleClick, true);
    window.addEventListener("pagehide", stop, { once: true });
    logger2?.info("controller.started");
    return stop;
  }
  function startSteamDiscoveryQueue({ logger: logger2 } = {}) {
    const runLogger = logger2?.child("run");
    runLogger?.info("lifecycle.started", {
      documentReadyState: document.readyState
    });
    const storeItemReader = createDiscoveryQueueStoreItemReader({
      logger: runLogger?.child("store-items")
    });
    const stopPrefilter = startDiscoveryQueuePrefilter({
      getLocalizedTags: storeItemReader.getLocalizedTags,
      getStoreItem: storeItemReader.get,
      prepareStoreItems: storeItemReader.prepareBatch,
      logger: runLogger?.child("prefilter")
    });
    const stopModalQueue = startModalQueue(runLogger?.child("modal"));
    let stopClassicQueue = () => {
    };
    let stopAutoFilter = () => {
    };
    let stopReviewCountFix = () => {
    };
    let stopped = false;
    function startQueueControllersWhenReady() {
      if (!stopped) {
        runLogger?.info("controllers.starting", {
          documentReadyState: document.readyState
        });
        stopClassicQueue = startClassicQueue(runLogger?.child("classic"));
        stopAutoFilter = startDiscoveryQueueAutoFilter({
          getStoreItem: storeItemReader.get,
          logger: runLogger
        });
        stopReviewCountFix = startModalReviewCountFix(
          runLogger?.child("modal-review-count")
        );
        runLogger?.info("controllers.started");
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
      runLogger?.info("lifecycle.stopping");
      stopped = true;
      document.removeEventListener("DOMContentLoaded", startQueueControllersWhenReady);
      stopModalQueue();
      stopPrefilter();
      stopClassicQueue();
      stopAutoFilter();
      stopReviewCountFix();
      storeItemReader.stop();
      runLogger?.info("lifecycle.stopped");
    };
  }

  // src/lib/steam/discovery-queue-log.js
  var PRODUCT_NAME = "Steam Discovery Queue";
  var sessionSequence = 0;
  function defaultNow() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
  function createDefaultElapsed() {
    const start = performance?.now?.() ?? Date.now();
    return () => (performance?.now?.() ?? Date.now()) - start;
  }
  function copyContext(context) {
    try {
      return context && typeof context === "object" ? { ...context } : {};
    } catch {
      return {};
    }
  }
  function safeCall(source) {
    try {
      return source();
    } catch {
      return null;
    }
  }
  function safeText(value, fallback) {
    try {
      const text = String(value);
      return text || fallback;
    } catch {
      return fallback;
    }
  }
  function createDiscoveryQueueLogger({
    scriptVersion,
    consoleTarget = console,
    now = defaultNow,
    elapsed = createDefaultElapsed()
  } = {}) {
    const sessionId = `dq-${Date.now().toString(36)}-${++sessionSequence}`;
    const state = {
      consoleTarget,
      elapsed,
      idSequence: 0,
      logSequence: 0,
      now,
      scriptVersion,
      sessionId
    };
    function nextId(prefix = "operation") {
      try {
        state.idSequence += 1;
        return `${state.sessionId}:${safeText(prefix, "operation")}:${state.idSequence}`;
      } catch {
        return `${state.sessionId}:operation`;
      }
    }
    function createChild(scope, context) {
      const stableScope = safeText(scope, "root");
      const stableContext = copyContext(context);
      function write(level, event, data, error, hasData) {
        try {
          state.logSequence += 1;
          const eventName = safeText(event, "unknown");
          const prefix = [
            `[${PRODUCT_NAME}]`,
            `[${state.sessionId}]`,
            `[#${state.logSequence}]`,
            `[${stableScope}.${eventName}]`
          ].join("");
          const metadata = {
            ...stableContext,
            scriptVersion: state.scriptVersion,
            timestamp: safeCall(state.now),
            elapsedMs: safeCall(state.elapsed)
          };
          const args = error === void 0 ? [prefix, metadata] : [prefix, metadata, error];
          if (hasData) {
            args.push(data);
          }
          const method = state.consoleTarget?.[level];
          if (typeof method === "function") {
            Reflect.apply(method, state.consoleTarget, args);
          }
        } catch {
          return void 0;
        }
      }
      return {
        sessionId: state.sessionId,
        nextId,
        child(childScope, childContext) {
          try {
            const nestedScope = stableScope === "root" ? safeText(childScope, "child") : `${stableScope}.${safeText(childScope, "child")}`;
            return createChild(
              nestedScope,
              { ...stableContext, ...copyContext(childContext) }
            );
          } catch {
            return createChild(stableScope, stableContext);
          }
        },
        debug(event, data) {
          write("debug", event, data, void 0, arguments.length >= 2);
        },
        info(event, data) {
          write("info", event, data, void 0, arguments.length >= 2);
        },
        warn(event, data) {
          write("warn", event, data, void 0, arguments.length >= 2);
        },
        error(event, error, data) {
          write("error", event, data, error, arguments.length >= 3);
        }
      };
    }
    return createChild("root");
  }

  // src/userscripts/steam-discovery-queue.user.js
  var logger = createDiscoveryQueueLogger({ scriptVersion: "0.3.19" });
  logger.info("script.started", {
    documentReadyState: document.readyState,
    url: location.href
  });
  startSteamDiscoveryQueue({ logger });
})();
