// ==UserScript==
// @name         Steam Discovery Queue Auto Next
// @name:zh-CN   Steam 探索队列自动下一项
// @namespace    https://github.com/blue-bird1/scriptcat
// @version      0.3.20
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
    } catch (error) {
      console.error(
        "[Steam 探索队列] 读取自动筛选设置失败，已改用默认设置。",
        error
      );
      return cloneDefaultConfig();
    }
  }
  function saveDiscoveryQueueConfig(value) {
    const config = normalizeConfig(value);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (error) {
      console.error(
        "[Steam 探索队列] 保存自动筛选设置失败，本页仍会使用刚才的设置。",
        error
      );
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
    } catch (error) {
      console.error("[Steam 探索队列] 无法解析页面中的 Steam 用户配置，跳过受限个人资料功能筛选", error);
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
          console.warn("[Steam 探索队列] Steam 限制了个人资料功能查询，本轮不再继续请求");
          return void 0;
        }
        if (!response.ok) {
          console.error(
            `[Steam 探索队列] 查询 App ${appId} 的个人资料功能失败：HTTP ${response.status} ${response.statusText}`.trim()
          );
          return void 0;
        }
        return parseProfileFeaturesLimited(await response.json(), appId);
      } catch (error) {
        console.error(`[Steam 探索队列] 查询或解析 App ${appId} 的个人资料功能时出错`, error);
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
      } catch (error) {
        console.error(`[Steam 探索队列] 解析 App ${appId} 的价格币种时出错`, error);
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
      if (!response.ok) {
        console.error(
          `[Steam 探索队列] 读取筛选数据失败：${url} 返回 HTTP ${response.status} ${response.statusText}`.trim()
        );
        return void 0;
      }
      return await response.json();
    } catch (error) {
      console.error(`[Steam 探索队列] 请求或解析筛选数据失败：${url}`, error);
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
      } catch (error) {
        console.error(`[Steam 探索队列] 读取 App ${appId} 的 Steam 商店缓存时出错`, error);
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
      let result;
      try {
        result = await ruleEngine.evaluate({
          appId: context.appId,
          reviews: context.reviews,
          tags: context.tags,
          config
        });
      } catch (error) {
        console.error(
          `[Steam 探索队列] 评估应用 ${context.appId} 的筛选规则时出错。`,
          error
        );
        return;
      }
      if (stopped || paused || currentGeneration !== generation || !result.matched) {
        return;
      }
      const current = getContext();
      if (current?.key !== context.key) {
        console.warn(
          `[Steam 探索队列] 应用 ${context.appId} 筛选完成时页面内容已经改变，因此没有自动忽略。`
        );
        return;
      }
      if (!(current.ignoreButton instanceof HTMLElement)) {
        console.warn(
          `[Steam 探索队列] 应用 ${context.appId} 命中筛选规则，但没有找到忽略按钮，无法自动忽略。`
        );
        return;
      }
      console.info(
        `[Steam 探索队列] 应用 ${context.appId} 命中筛选规则，已点击忽略。`
      );
      current.ignoreButton.click();
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
      if (!queueRequest) {
        console.warn("[Steam 探索队列] 无法解析探索队列请求中的 protobuf 参数，保留 Steam 原始处理");
      }
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
    } catch (error) {
      console.warn("[Steam 探索队列] 页面 SNR 配置不可解析，忽略请求将不携带 SNR", error);
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
  function createPrefilterReporter() {
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
      },
      beginEvaluation() {
        render(`正在筛选第 ${batches} 批`);
      },
      recordEvaluation(appId, result) {
        checked += 1;
        render(`正在筛选第 ${batches} 批`);
        if (result?.matched === true) {
          console.info(
            `[Steam 探索队列] App ${appId} 命中筛选规则：${result.reasons.join("、")}`
          );
        }
      },
      recordIgnore(appId, succeeded) {
        if (succeeded) {
          ignored += 1;
          render(`正在忽略第 ${batches} 批命中项`);
          console.info(`[Steam 探索队列] 已忽略 App ${appId}`);
        }
      },
      finishBatch(retainedAppIds, matchedAppIds) {
        console.info(
          `[Steam 探索队列] 第 ${batches} 批筛选完成：筛除 ${matchedAppIds.length} 项，保留 ${retainedAppIds.length} 项`
        );
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
    prepareStoreItems
  } = {}) {
    if (typeof window !== "object" || typeof window.fetch !== "function") {
      return () => {
      };
    }
    const permits = /* @__PURE__ */ new Map();
    const deliveredDialogs = /* @__PURE__ */ new WeakSet();
    const ruleEngine = createDiscoveryQueueRuleEngine({ getStoreItem });
    const originalFetch = window.fetch;
    let stopped = false;
    let generation = 0;
    let pollTimer;
    let queueCache;
    let originalQueueMultiple;
    let queueMultipleWrapper;
    function grantPermit(appIds, request, args, receiver) {
      const key = appIdKey(appIds);
      if (key !== void 0 && appIds.length > 0) {
        permits.set(key, {
          args,
          expiresAt: Date.now() + PERMIT_DURATION_MS,
          receiver,
          request
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
      return permit?.expiresAt >= Date.now() ? permit : void 0;
    }
    async function ignoreApp(appId) {
      if (typeof window.g_sessionID !== "string" || !window.g_sessionID) {
        console.warn(`[Steam 探索队列] 无法忽略 App ${appId}：页面缺少 Steam 会话 ID`);
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
      try {
        const response = await Reflect.apply(originalFetch, window, [
          "/recommended/ignorerecommendation",
          {
            method: "POST",
            body: form
          }
        ]);
        if (!response.ok) {
          console.error(
            `[Steam 探索队列] 忽略 App ${appId} 失败：HTTP ${response.status} ${response.statusText}`.trim()
          );
          return false;
        }
        let payload;
        try {
          payload = await response.json();
        } catch (error) {
          console.error(`[Steam 探索队列] 无法解析 App ${appId} 的忽略响应`, error);
          return false;
        }
        const succeeded = payload?.success === true || payload?.success === 1;
        if (!succeeded) {
          console.warn(
            `[Steam 探索队列] Steam 未接受 App ${appId} 的忽略请求（success=${String(payload?.success)}）`
          );
        }
        return succeeded;
      } catch (error) {
        console.error(`[Steam 探索队列] 请求忽略 App ${appId} 时出错`, error);
        return false;
      }
    }
    async function prefilter(appIds, config, currentGeneration, reporter) {
      const requiredLanguages = config.requiredLanguages?.enabled === true ? config.requiredLanguages.value : [];
      if (typeof prepareStoreItems === "function") {
        try {
          await prepareStoreItems(appIds, requiredLanguages);
        } catch (error) {
          console.error("[Steam 探索队列] 批量读取商店数据失败，无法完成本批筛选", error);
          throw error;
        }
      }
      if (stopped || currentGeneration !== generation) {
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
          console.error(`[Steam 探索队列] 筛选 App ${appId} 时出错，保留该项目供用户查看`, error);
          return false;
        } finally {
          reporter?.recordEvaluation(appId, report);
        }
      });
      if (stopped || currentGeneration !== generation) {
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
      return { ignoreCompletion, retainedAppIds };
    }
    function replaceAppIds(target, replacement) {
      target.splice(0, target.length, ...replacement);
    }
    async function loadNextVisibleBatch(permit, dataRequest, queueReceiver, config, currentGeneration, seenBatches, reporter) {
      let fetchArgs = createRebuildFetchArgs(permit.args, permit.request);
      if (!fetchArgs) {
        console.warn("[Steam 探索队列] 无法构造下一批队列请求，改为展示队列结束页");
        return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
      }
      while (!stopped && currentGeneration === generation) {
        let response;
        try {
          response = await Reflect.apply(originalFetch, permit.receiver, fetchArgs);
        } catch (error) {
          console.error("[Steam 探索队列] 请求下一批探索队列失败，改为展示队列结束页", error);
          return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
        }
        if (!response?.ok || !isOctetStream(response)) {
          const status = response ? `HTTP ${response.status} ${response.statusText}`.trim() : "没有收到响应";
          const contentType = response?.headers?.get?.("content-type") ?? "未知内容类型";
          console.warn(
            `[Steam 探索队列] 下一批队列响应不可用（${status}，${contentType}），改为展示队列结束页`
          );
          return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
        }
        let appIds;
        try {
          appIds = decodeDiscoveryQueueAppIds(await response.clone().arrayBuffer());
        } catch (error) {
          console.error("[Steam 探索队列] 无法解析下一批探索队列，改为展示队列结束页", error);
          return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
        }
        const key = appIdKey(appIds);
        if (!appIds || key === void 0) {
          console.warn("[Steam 探索队列] 下一批队列没有有效的 AppID，改为展示队列结束页");
          return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
        }
        if (appIds.length === 0) {
          console.info("[Steam 探索队列] Steam 返回空队列，展示队列结束页");
          return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
        }
        if (seenBatches.has(key)) {
          console.warn("[Steam 探索队列] Steam 重复返回同一批项目，为避免循环而展示队列结束页");
          return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
        }
        seenBatches.add(key);
        reporter?.beginBatch(appIds);
        try {
          await Reflect.apply(originalQueueMultiple, queueReceiver, [appIds, dataRequest]);
        } catch (error) {
          console.error("[Steam 探索队列] 下一批商店数据读取失败，改为展示队列结束页", error);
          return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
        }
        const filteredBatch = await prefilter(
          appIds,
          config,
          currentGeneration,
          reporter
        );
        if (!filteredBatch) {
          console.info("[Steam 探索队列] 页面状态已变化，停止继续换批并保留 Steam 当前队列");
          return appIds;
        }
        if (filteredBatch.retainedAppIds.length > 0) {
          return filteredBatch.retainedAppIds;
        }
        await filteredBatch.ignoreCompletion;
      }
      console.info(
        stopped ? "[Steam 探索队列] 预筛选已停止，展示队列结束页" : "[Steam 探索队列] 页面队列已变化，停止换批并展示队列结束页"
      );
      return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
    }
    function wrappedFetch(...args) {
      const responsePromise = Reflect.apply(originalFetch, this, args);
      let request;
      try {
        request = getFetchRequest(args[0], args[1]);
      } catch (error) {
        console.error("[Steam 探索队列] 无法解析探索队列请求，保留 Steam 原始处理", error);
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
          console.error("[Steam 探索队列] 无法解析 Steam 返回的探索队列，保留原始响应", error);
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
            return result;
          }
          const permit = takePermit(snapshot);
          if (deliveredDialogs.has(dialog) && !permit?.request.queueRequest.rebuild) {
            return result;
          }
          deliveredDialogs.add(dialog);
          let config;
          try {
            config = loadDiscoveryQueueConfig();
          } catch (error) {
            console.error("[Steam 探索队列] 无法读取自动筛选配置，保留 Steam 原始队列", error);
            return result;
          }
          if (config?.enabled !== true || !hasActiveRules(config)) {
            return result;
          }
          const currentGeneration = generation;
          const queueReceiver = this;
          const reporter = createPrefilterReporter();
          reporter.beginBatch(snapshot);
          return Promise.resolve(result).then(async (value) => {
            const filteredBatch = await prefilter(
              snapshot,
              config,
              currentGeneration,
              reporter
            );
            if (!filteredBatch || stopped || currentGeneration !== generation) {
              return value;
            }
            if (filteredBatch.retainedAppIds.length > 0) {
              replaceAppIds(appIds, filteredBatch.retainedAppIds);
              return value;
            }
            await filteredBatch.ignoreCompletion;
            if (stopped || currentGeneration !== generation) {
              console.info("[Steam 探索队列] 页面状态已变化，停止换批并保留 Steam 当前队列");
              return value;
            }
            if (!permit) {
              console.warn("[Steam 探索队列] 缺少可复用的队列请求，无法获取下一批，改为展示队列结束页");
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
  function readSteamLanguage() {
    try {
      const config = document.querySelector("#application_config[data-config]")?.dataset.config;
      const language = config ? JSON.parse(config).LANGUAGE : void 0;
      if (typeof language === "string" && language) {
        return language;
      }
    } catch (error) {
      console.warn("[Steam 探索队列] 页面语言配置不可解析，改用页面 HTML 语言", error);
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
  function readCachedTags(language) {
    try {
      const value = JSON.parse(
        localStorage.getItem(`${TAG_CACHE_PREFIX}${language}`) ?? "null"
      );
      const tags = parseTags(value?.tags);
      return tags ? { tags, versionHash: String(value.version_hash ?? "") } : void 0;
    } catch (error) {
      console.warn(`[Steam 探索队列] 本地 ${language} 标签目录损坏，将重新获取`, error);
      return void 0;
    }
  }
  function saveCachedTags(language, value) {
    try {
      localStorage.setItem(
        `${TAG_CACHE_PREFIX}${language}`,
        JSON.stringify({
          tags: value.tags.map(([tagid, name]) => ({ tagid, name })),
          version_hash: value.versionHash
        })
      );
    } catch (error) {
      console.warn(`[Steam 探索队列] 无法保存 ${language} 标签目录到 Steam 本地缓存`, error);
      return false;
    }
    return true;
  }
  async function loadTagNames(language) {
    const cached = readCachedTags(language);
    if (cached) {
      return new Map(cached.tags);
    }
    const url = new URL(TAG_LIST_URL);
    url.searchParams.set("language", language);
    url.searchParams.set("origin", location.origin);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.error(
          `[Steam 探索队列] 获取 ${language} 标签目录失败：HTTP ${response.status} ${response.statusText}`.trim()
        );
        return /* @__PURE__ */ new Map();
      }
      const payload = (await response.json())?.response;
      const tags = parseTags(payload?.tags);
      if (tags) {
        const value = {
          tags,
          versionHash: String(payload.version_hash ?? "")
        };
        saveCachedTags(language, value);
        return new Map(tags);
      }
      console.warn(`[Steam 探索队列] Steam 返回的 ${language} 标签目录格式无效`);
    } catch (error) {
      console.error(`[Steam 探索队列] 请求或解析 ${language} 标签目录时出错`, error);
      return /* @__PURE__ */ new Map();
    }
    return /* @__PURE__ */ new Map();
  }
  function createDiscoveryQueueTagCatalog() {
    const catalogs = /* @__PURE__ */ new Map();
    return {
      async getNames(tagIds) {
        if (!Array.isArray(tagIds) || tagIds.length === 0) {
          return [];
        }
        const language = readSteamLanguage();
        let catalogPromise = catalogs.get(language);
        if (!catalogPromise) {
          catalogPromise = loadTagNames(language);
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
  function readArray(getter, appId, fieldName) {
    try {
      const value = getter();
      return Array.isArray(value) ? value.filter((entry) => Number.isSafeInteger(entry) && entry > 0) : [];
    } catch (error) {
      console.error(`[Steam 探索队列] 读取 App ${appId} 的${fieldName}时出错`, error);
      return [];
    }
  }
  function readSupportedLanguages(item, appId) {
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
      console.error(`[Steam 探索队列] 读取 App ${appId} 的支持语言时出错`, error);
      return void 0;
    }
  }
  function readDescriptionHasChinese(item, appId) {
    if (typeof item.GetShortDescription !== "function") {
      return void 0;
    }
    try {
      const description = item.GetShortDescription();
      return typeof description === "string" ? /\p{Script=Han}/u.test(description) : void 0;
    } catch (error) {
      console.error(`[Steam 探索队列] 读取 App ${appId} 的商店简介时出错`, error);
      return void 0;
    }
  }
  function readAppType(item, appId) {
    if (typeof item?.GetAppType !== "function") {
      return void 0;
    }
    try {
      const appType = item.GetAppType();
      return Number.isSafeInteger(appType) && appType >= 0 ? appType : void 0;
    } catch (error) {
      console.error(`[Steam 探索队列] 读取 App ${appId} 的应用类型时出错`, error);
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
  function readReviewSummary(item, appId) {
    const preferUnfiltered = window.GDynamicStore?.s_preferences?.review_score_preference === 1;
    const summaryGetter = preferUnfiltered ? item.GetUnfilteredReviewSummary : item.GetFilteredReviewSummary;
    let summary;
    try {
      summary = summaryGetter?.call(item);
    } catch (error) {
      console.error(`[Steam 探索队列] 读取 App ${appId} 的评测摘要时出错`, error);
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
      const appType = readAppType(item, appId);
      const reviews = readReviewSummary(item, appId);
      const storeItem = {
        appId,
        success: 1,
        isFree: item.BIsFree?.(),
        comingSoon,
        descriptionHasChinese: readDescriptionHasChinese(item, appId),
        isDlc: appType === void 0 ? void 0 : appType === DLC_APP_TYPE,
        supportedLanguages: readSupportedLanguages(item, appId),
        tagIds: readArray(() => item.GetTagIDs?.(), appId, "标签"),
        categoryIds: {
          supportedPlayers: readArray(
            () => item.GetStoreCategories_SupportedPlayers?.(),
            appId,
            "玩家模式分类"
          ),
          features: readArray(
            () => item.GetStoreCategories_Features?.(),
            appId,
            "功能分类"
          ),
          controllers: readArray(
            () => item.GetStoreCategories_Controller?.(),
            appId,
            "控制器分类"
          )
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
      console.error(`[Steam 探索队列] 读取 App ${appId} 的 Steam 商店缓存时出错`, error);
      return void 0;
    }
  }
  function createDiscoveryQueueStoreItemReader() {
    const tagCatalog = createDiscoveryQueueTagCatalog();
    let stopped = false;
    return {
      async prepareBatch(appIds, requiredLanguages) {
        if (stopped || !Array.isArray(appIds) || !Array.isArray(requiredLanguages) || requiredLanguages.length === 0) {
          return;
        }
        const cache = await waitForStoreItemCache();
        if (!cache || typeof cache.QueueMultipleAppRequests !== "function" || stopped) {
          return;
        }
        const acceptsChineseDescription = requiredLanguages.some(
          (language) => CHINESE_LANGUAGE_IDS.has(language)
        );
        let missingAppIds;
        try {
          missingAppIds = appIds.filter((appId) => {
            const item = cache.GetApp(appId);
            return !(acceptsChineseDescription && readDescriptionHasChinese(item, appId) === true) && !item?.BContainDataRequest?.(SUPPORTED_LANGUAGES_REQUEST);
          });
        } catch (error) {
          console.error("[Steam 探索队列] 检查本批支持语言缓存时出错", error);
          return;
        }
        if (missingAppIds.length === 0) {
          return;
        }
        try {
          await cache.QueueMultipleAppRequests(
            missingAppIds,
            SUPPORTED_LANGUAGES_REQUEST
          );
        } catch (error) {
          console.error(
            `[Steam 探索队列] 批量补齐 ${missingAppIds.length} 个 App 的支持语言时出错`,
            error
          );
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
        const cache = await waitForStoreItemCache();
        if (!cache || stopped) {
          return void 0;
        }
        try {
          let item = cache.GetApp(numericAppId);
          const request = buildStoreItemRequest(
            requirements,
            readAppType(item, numericAppId)
          );
          if (Object.keys(request).length > 0 && !item?.BContainDataRequest?.(request)) {
            await cache.QueueAppRequest(numericAppId, request);
            item = cache.GetApp(numericAppId);
          }
          return readStoreItem(item, numericAppId);
        } catch (error) {
          console.error(`[Steam 探索队列] 请求或读取 App ${appId} 的 Steam 商店数据时出错`, error);
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
        const cache = await waitForStoreItemCache();
        if (!cache || stopped) {
          return [];
        }
        try {
          const tagIds = readArray(
            () => cache.GetApp(numericAppId)?.GetTagIDs?.(),
            numericAppId,
            "标签"
          );
          const uniqueTagIds = [...new Set(tagIds)];
          if (uniqueTagIds.length === 0) {
            return [];
          }
          return await tagCatalog.getNames(uniqueTagIds);
        } catch (error) {
          console.error(`[Steam 探索队列] 读取 App ${appId} 的本地化标签时出错`, error);
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
    function advance(reason, delay = ADVANCE_DELAY_MS) {
      stopWaiting();
      advancing = true;
      timer = setTimeout(() => {
        timer = void 0;
        const triggerNext = () => {
          frame = void 0;
          const currentNextButton = document.querySelector(CLASSIC_NEXT_SELECTOR);
          if (currentNextButton instanceof HTMLElement) {
            currentNextButton.click();
          } else {
            const appId = location.pathname.match(/^\/app\/(\d+)(?:\/|$)/)?.[1];
            console.warn(
              `[Steam 探索队列] 应用 ${appId ?? "未知"}：${reason}，但没有找到“下一项”按钮，无法继续。`
            );
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
          advance("加入愿望单成功");
          return;
        }
        if (hasFailed()) {
          const appId = location.pathname.match(/^\/app\/(\d+)(?:\/|$)/)?.[1];
          console.warn(
            `[Steam 探索队列] 应用 ${appId ?? "未知"} 加入愿望单失败，当前项目不会自动跳过。`
          );
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
      timer = setTimeout(() => {
        const appId = location.pathname.match(/^\/app\/(\d+)(?:\/|$)/)?.[1];
        console.warn(
          `[Steam 探索队列] 等待应用 ${appId ?? "未知"} 加入愿望单结果超时，当前项目不会自动跳过。`
        );
        stopWaiting();
      }, QUEUE_TIMEOUT_MS);
    }
    function handleClick(event) {
      const { target } = event;
      if (matchesAction(target, "#add_to_wishlist_area a.add_to_wishlist")) {
        waitForResult("wishlist");
      } else if (matchesAction(target, ".queue_btn_ignore .queue_btn_inactive") || matchesAction(target, "#queue_ignore_menu_option_not_interested") || matchesAction(target, "#queue_ignore_menu_option_owned_elsewhere")) {
        advance("忽略操作已提交", 0);
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
  function startModalReviewCountFix() {
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
          element.textContent = `(${match[1]})`;
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
  function monitorActionRequests(takePending, handleResult) {
    if (typeof window.fetch !== "function") {
      return () => {
      };
    }
    const originalFetch = window.fetch;
    function monitoredFetch(...args) {
      let pathname;
      try {
        pathname = getMonitoredPath(args[0], args[1]);
      } catch {
        return Reflect.apply(originalFetch, this, args);
      }
      if (!pathname) {
        return Reflect.apply(originalFetch, this, args);
      }
      const pending = takePending(pathname);
      let response;
      try {
        response = Reflect.apply(originalFetch, this, args);
      } catch (error) {
        if (pending) {
          console.error(
            `[Steam 探索队列] 应用 ${pending.appId ?? "未知"} 的加入愿望单请求未能发出。`,
            error
          );
          handleResult(pending);
        }
        throw error;
      }
      if (!pending) {
        return response;
      }
      return response.then(
        (result) => {
          handleResult(pending, result);
          return result;
        },
        (error) => {
          console.error(
            `[Steam 探索队列] 应用 ${pending.appId ?? "未知"} 的加入愿望单请求失败，当前项目不会自动跳过。`,
            error
          );
          handleResult(pending);
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
          console.warn(
            `[Steam 探索队列] 应用 ${pending.appId ?? "未知"} 执行${pending.action === "wishlist" ? "加入愿望单" : "忽略"}后，等待“下一项”按钮超时，无法自动继续。`
          );
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
        if (!pending.button.isConnected) {
          if (pending.dialog.isConnected) {
            console.warn(
              `[Steam 探索队列] 应用 ${pending.appId ?? "未知"} 加入愿望单请求成功，但操作按钮已经消失，无法确认页面状态。`
            );
          }
          removePending(pending);
          return;
        }
        if (pending.button.className === pending.initialClassName) {
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
      (pending, response) => {
        if (!pendingActions.has(pending)) {
          return;
        }
        if (response?.ok) {
          clearTimeout(pending.timer);
          pending.timer = setTimeout(() => {
            if (pending.dialog.isConnected) {
              console.warn(
                `[Steam 探索队列] 应用 ${pending.appId ?? "未知"} 加入愿望单请求成功，但等待页面确认超时，当前项目不会自动跳过。`
              );
            }
            removePending(pending);
          }, QUEUE_TIMEOUT_MS);
          waitForSelectedState(pending);
        } else {
          if (response) {
            console.error(
              `[Steam 探索队列] 应用 ${pending.appId ?? "未知"} 的加入愿望单请求返回 HTTP ${response.status}，当前项目不会自动跳过。`
            );
          }
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
      pending.timer = setTimeout(() => {
        if (pending.dialog.isConnected) {
          console.warn(
            `[Steam 探索队列] 等待应用 ${pending.appId ?? "未知"} 的加入愿望单请求超时，当前项目不会自动跳过。`
          );
        }
        removePending(pending);
      }, QUEUE_TIMEOUT_MS);
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
    const stopPrefilter = startDiscoveryQueuePrefilter({
      getLocalizedTags: storeItemReader.getLocalizedTags,
      getStoreItem: storeItemReader.get,
      prepareStoreItems: storeItemReader.prepareBatch
    });
    const stopModalQueue = startModalQueue();
    let stopClassicQueue = () => {
    };
    let stopAutoFilter = () => {
    };
    let stopReviewCountFix = () => {
    };
    let stopped = false;
    function startQueueControllersWhenReady() {
      if (!stopped) {
        stopClassicQueue = startClassicQueue();
        stopAutoFilter = startDiscoveryQueueAutoFilter({
          getStoreItem: storeItemReader.get
        });
        stopReviewCountFix = startModalReviewCountFix();
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
      stopPrefilter();
      stopClassicQueue();
      stopAutoFilter();
      stopReviewCountFix();
      storeItemReader.stop();
    };
  }

  // src/userscripts/steam-discovery-queue.user.js
  startSteamDiscoveryQueue();
})();
