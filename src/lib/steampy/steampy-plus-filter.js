import { mountSteamPyBuyerToolbar } from "./steampy-plus-toolbar.js";

const FILTER_STORAGE_KEY = "steamPriceFilterState";
const OWNED_MENU_ID = "steam-py-plus-hide-owned";
const DEFAULT_FILTER_STATE = {
  minPrice: 0,
  maxPrice: 9999,
  isActive: false,
  hideDlc: false,
  hideOwned: true,
};
const INPUT_STYLE = "width:.7rem;height:.28rem;padding:0 .08rem;border:1px solid #ccc;border-radius:.04rem;box-sizing:border-box;font-size:.13rem;line-height:.12rem;";
const PRESET_STYLE = "padding:.04rem .1rem;border-radius:.04rem;cursor:pointer;font-size:.13rem;border:1px solid #ddd;color:#666;background:transparent;transition:all .2s;box-sizing:border-box;height:.25rem;line-height:.17rem;";

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

export function createSteamPyPriceFilter({ libraryManager, onApply }) {
  const state = loadFilterState();
  let hideDlcSuspended = false;
  let ownedMenuRegistered = false;

  function save() {
    GM_setValue(FILTER_STORAGE_KEY, JSON.stringify(state));
  }

  function hidesOwnedGames() {
    return state.hideOwned !== false;
  }

  function shouldShow(game) {
    const price = Number(game?.keyTxAmt ?? game?.keyPrice);
    const matchesPrice = !state.isActive || (price >= state.minPrice && price <= state.maxPrice);
    const ownedHidden = hidesOwnedGames() && libraryManager.isGameOwned(game?.appId);
    return matchesPrice
      && (hideDlcSuspended || !state.hideDlc || game?.steamApp?.type !== "dlc")
      && !ownedHidden
      && !libraryManager.isGameIgnored(game?.appId);
  }

  function setHideDlcSuspended(suspended) {
    hideDlcSuspended = Boolean(suspended);
  }

  function notifyOwnedVisibility() {
    const text = hidesOwnedGames()
      ? "CDKey 列表已隐藏已拥有游戏"
      : "CDKey 列表已显示已拥有游戏";
    try {
      GM_notification({ title: "SteamPy Plus", text, timeout: 3000 });
    } catch (error) {
      console.log(`[SteamPy Plus] ${text}`, error);
    }
  }

  function syncOwnedControl() {
    const input = document.getElementById("steamPyPlusHideOwned");
    if (input) input.checked = hidesOwnedGames();
  }

  function registerOwnedMenu() {
    if (typeof GM_registerMenuCommand !== "function") return;
    const stateLabel = hidesOwnedGames() ? "隐藏（点击显示）" : "显示（点击隐藏）";
    GM_registerMenuCommand(`已拥有游戏：${stateLabel}`, toggleHideOwned, { id: OWNED_MENU_ID });
    ownedMenuRegistered = true;
  }

  function setHideOwned(hideOwned, { notifyUser = false } = {}) {
    state.hideOwned = hideOwned !== false;
    save();
    syncOwnedControl();
    registerOwnedMenu();
    if (notifyUser) notifyOwnedVisibility();
    apply();
  }

  function toggleHideOwned() {
    setHideOwned(!hidesOwnedGames(), { notifyUser: true });
  }

  function registerMenus() {
    if (ownedMenuRegistered) return;
    registerOwnedMenu();
  }

  function apply() {
    syncOwnedControl();
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
      const matches = state.isActive
        && state.minPrice === Number(button.dataset.steamPyPlusMin)
        && state.maxPrice === Number(button.dataset.steamPyPlusMax);
      button.style.cssText = highlight && matches
        ? `${PRESET_STYLE}border:1px solid #409EFF;color:#fff;background:#409EFF;`
        : PRESET_STYLE;
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
    mountSteamPyBuyerToolbar();
    syncOwnedControl();
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
    const hideOwnedInput = document.createElement("input");
    hideOwnedInput.id = "steamPyPlusHideOwned";
    hideOwnedInput.type = "checkbox";
    hideOwnedInput.checked = hidesOwnedGames();
    hideOwnedInput.addEventListener("change", (event) => {
      setHideOwned(event.target.checked);
    });
    const hideOwnedLabel = document.createElement("label");
    hideOwnedLabel.htmlFor = hideOwnedInput.id;
    hideOwnedLabel.textContent = "隐藏已拥有";
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
    inputs.append(hideDlcInput, hideDlcLabel, hideOwnedInput, hideOwnedLabel, minInput, document.createTextNode("-"), maxInput, button);
    container.append(title, presets, inputs);
    target.appendChild(container);
    syncInputs();
    updatePresets();
  }

  return { apply, hidesOwnedGames, mount, registerMenus, setHideDlcSuspended, shouldShow };
}
