import { STEAM_LANGUAGE_OPTIONS } from "./discovery-queue-languages.js";

const STORAGE_KEY = "scriptcat:steam-discovery-queue:config:v1";
const BUTTON_ID = "scriptcat-steam-discovery-queue-config-button";
const POPUP_ID = "scriptcat-steam-discovery-queue-config-popup";
const STYLE_ID = "scriptcat-steam-discovery-queue-config-style";

export const DEFAULT_DISCOVERY_QUEUE_CONFIG = {
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
  requiredLanguages: { enabled: false, value: [6, 7] },
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
    ignoreProfileFeaturesLimited:
      DEFAULT_DISCOVERY_QUEUE_CONFIG.ignoreProfileFeaturesLimited,
    autoContinueQueue: DEFAULT_DISCOVERY_QUEUE_CONFIG.autoContinueQueue,
    excludedTags: { ...DEFAULT_DISCOVERY_QUEUE_CONFIG.excludedTags, value: [] },
    requiredLanguages: {
      ...DEFAULT_DISCOVERY_QUEUE_CONFIG.requiredLanguages,
      value: [...DEFAULT_DISCOVERY_QUEUE_CONFIG.requiredLanguages.value],
    },
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeNumber(value, fallback, maximum = Infinity) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(0, number));
}

function normalizeDate(value, fallback) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return fallback;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? fallback
    : value;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const tags = [];
  const seen = new Set();
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
    (language) => language.value,
  );
}

function normalizeRule(value, fallback, maximum) {
  if (!isRecord(value)) {
    return { ...fallback };
  }
  return {
    enabled: normalizeBoolean(value.enabled, fallback.enabled),
    value: normalizeNumber(value.value, fallback.value, maximum),
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
      value: normalizeDate(value.earliestReleaseDate?.value, fallback.earliestReleaseDate.value),
    },
    ignoreFree: normalizeBoolean(value.ignoreFree, fallback.ignoreFree),
    ignoreUnreviewed: normalizeBoolean(value.ignoreUnreviewed, fallback.ignoreUnreviewed),
    ignoreDlc: normalizeBoolean(value.ignoreDlc, fallback.ignoreDlc),
    ignoreProfileFeaturesLimited: normalizeBoolean(
      value.ignoreProfileFeaturesLimited,
      fallback.ignoreProfileFeaturesLimited,
    ),
    autoContinueQueue: normalizeBoolean(
      value.autoContinueQueue,
      fallback.autoContinueQueue,
    ),
    excludedTags: {
      enabled: normalizeBoolean(tags.enabled, fallback.excludedTags.enabled),
      value: normalizeTags(tags.value),
    },
    requiredLanguages: {
      enabled:
        requiredLanguages.length > 0 &&
        normalizeBoolean(languages.enabled, fallback.requiredLanguages.enabled),
      value: requiredLanguages,
    },
  };
}

export function loadDiscoveryQueueConfig() {
  try {
    const serialized = localStorage.getItem(STORAGE_KEY);
    return serialized === null ? cloneDefaultConfig() : normalizeConfig(JSON.parse(serialized));
  } catch {
    return cloneDefaultConfig();
  }
}

export function saveDiscoveryQueueConfig(value) {
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

export function createDiscoveryQueueConfigUi({ onSave, onOpenChange } = {}) {
    let config = loadDiscoveryQueueConfig();
  let button;
  let popup;
  let backdrop;
  let tags = [];
  let selectedLanguages = new Set();
  let removeKeydown = () => {};
  let removeButtonClick = () => {};

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
    removeKeydown = () => {};
    popup.remove();
    backdrop.remove();
    popup = undefined;
    backdrop = undefined;
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
      "popup_block_new popup_body popup_menu scriptcat-discovery-queue-config-popup",
    );
    popup.id = POPUP_ID;
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-modal", "true");
    popup.setAttribute("aria-label", "自动筛选设置");
    const title = appendText(createElement("h2"), "自动筛选设置");
    const description = appendText(
      createElement("p"),
      "多个已启用规则之间按 OR 匹配；评分、评论数、价格、折扣或发布日期缺失的项目不会自动处理。",
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
      draft.ignoreProfileFeaturesLimited,
    );
    const autoContinueQueue = addCheckbox(
      fields,
      "探索结束后自动继续下一次",
      draft.autoContinueQueue,
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
    const languageInputs = new Map();
    for (const language of STEAM_LANGUAGE_OPTIONS) {
      const input = addCheckbox(
        languageContainer,
        language.label,
        selectedLanguages.has(language.value),
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
        [...languageInputs]
          .filter(([, input]) => input.checked)
          .map(([language]) => language),
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
      ignoreProfileFeaturesLimited.checked =
        defaults.ignoreProfileFeaturesLimited;
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
          value: [...selectedLanguages],
        },
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
      return undefined;
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
      button = undefined;
    },
  };
}
