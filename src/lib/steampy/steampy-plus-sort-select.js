const TOOLBAR_SELECTOR = ".tag.flex-row.align-items-center";
const NATIVE_CONTROL_SELECTOR = ":scope > .tagBtn, :scope > .tagBtnTwo";
const SELECT_ID = "steamPyPlusSortSelect";
const NOTE_ID = "steamPyPlusSortNote";
const ENABLED_STORAGE_KEY = "steamPyPlusSortSelectEnabled";
const BOUNDARY_STORAGE_KEY = "steamPyPlusSortBoundary";
const MENU_ID = "steam-py-plus-sort-select";
const LOG_PREFIX = "[SteamPy Plus][SortSelect]";
// 空值前缀约占列表前 9%，来自实测评测；学习后的比例会覆盖它，区域差异靠翻页观察逐步校正。
const DEFAULT_NULL_RATIO = 0.093;
const NATIVE_FLAGS = ["chooseOne", "chooseTwo", "chooseThree", "chooseFour", "chooseFive"];

// 原生方法会连同排序状态一起更新页面，优先复用；自定义项直接改写查询参数。
const SORT_OPTIONS = Object.freeze([
  { value: "new", label: "最新", method: "newSort", sort: "createTime", order: "desc" },
  { value: "week", label: "周销量", method: "weekSort", sort: "cdkCount", order: "desc" },
  { value: "sales", label: "销量", method: "saleSort", sort: "keyTx", order: "desc" },
  { value: "discount", label: "折扣", method: "disCountSort", sort: "keyDiscount", order: "asc" },
  { value: "price-asc", label: "价格从低到高", method: "priceUp", sort: "keyPrice", order: "asc" },
  { value: "price-desc", label: "价格从高到低", method: "priceDown", sort: "keyPrice", order: "desc" },
  { value: "txamt-asc", label: "实付价从低到高", sort: "keyTxAmt", order: "asc" },
  { value: "aveamt-asc", label: "成交均价从低到高", sort: "keyAveAmt", order: "asc" },
  { value: "rating-desc", label: "好评率从高到低", sort: "rating", order: "desc" },
]);

function log(level, event, fields = {}) {
  const entry = { time: new Date().toISOString(), level, event, ...fields };
  const write = level === "error" ? console.error : console.info;
  write(LOG_PREFIX, entry);
}

function hasValue(row, field) {
  const value = row?.[field];
  return value !== null && value !== undefined && value !== "";
}

export function createSteamPySortSelectController({
  advancedFilter = null,
  getValue = GM_getValue,
  setValue = GM_setValue,
  registerMenuCommand = GM_registerMenuCommand,
} = {}) {
  let enabled = getValue(ENABLED_STORAGE_KEY, false) === true;
  let menusRegistered = false;
  let vm = null;
  let select = null;
  let note = null;
  const hiddenControls = [];
  const hiddenCards = new Set();

  function loadBoundary() {
    const raw = getValue(BOUNDARY_STORAGE_KEY, "");
    if (!raw) return { ratio: DEFAULT_NULL_RATIO, fields: {} };
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const ratio = Number(parsed?.ratio);
      return {
        ratio: Number.isFinite(ratio) && ratio > 0 && ratio < 0.9 ? ratio : DEFAULT_NULL_RATIO,
        fields: parsed?.fields && typeof parsed.fields === "object" ? parsed.fields : {},
      };
    } catch {
      return { ratio: DEFAULT_NULL_RATIO, fields: {} };
    }
  }

  function saveBoundary(boundary) {
    setValue?.(BOUNDARY_STORAGE_KEY, JSON.stringify(boundary));
  }

  function boundaryKey(target, field) {
    return `${target?.areas || "cn"}:${field}`;
  }

  // 只用已观察结果推导落点：有值页与空值页各自记忆，不再发探测请求。
  function estimatePage(target, option) {
    const boundary = loadBoundary();
    const learning = boundary.fields?.[boundaryKey(target, option.sort)] || {};
    const totalPages = Number(target?.totalPage) || 0;
    if (Number.isFinite(Number(learning.valuePage))) return Number(learning.valuePage);
    if (Number.isFinite(Number(learning.nullPage))) return Math.max(1, Number(learning.nullPage) + 1);
    if (totalPages > 0) {
      return Math.max(1, Math.min(totalPages, Math.round(boundary.ratio * totalPages)));
    }
    return 1;
  }

  function learnPage(target, option, currentPage, games) {
    if (!target || !option || option.method || option.order !== "asc") return;
    if (!Array.isArray(games) || games.length === 0) return;
    const key = boundaryKey(target, option.sort);
    const boundary = loadBoundary();
    const learning = boundary.fields[key] || {};
    const priced = games.filter((game) => hasValue(game, option.sort)).length;
    if (priced === 0) {
      learning.nullPage = Math.max(Number(learning.nullPage) || 0, currentPage);
    } else {
      learning.valuePage = Number(learning.valuePage) || currentPage;
      learning.valuePage = Math.min(learning.valuePage, currentPage);
      const totalPages = Number(target.totalPage) || 0;
      if (totalPages > 0) boundary.ratio = Math.min(0.9, Math.max(0.001, currentPage / totalPages));
    }
    learning.at = Date.now();
    boundary.fields[key] = learning;
    saveBoundary(boundary);
  }

  function currentOption(target) {
    return SORT_OPTIONS.find((option) => !option.method
      && option.sort === target?.searchForm?.sort
      && option.order === target?.searchForm?.order) || null;
  }

  function updateNote(target) {
    if (!note) return;
    const option = currentOption(target);
    const games = Array.isArray(target?.gameList) ? target.gameList : [];
    const emptyPage = Boolean(option && option.order === "asc" && games.length > 0
      && !games.some((game) => hasValue(game, option.sort)));
    note.hidden = !emptyPage;
    note.textContent = emptyPage ? "本页无成交价数据，翻到下一页查看" : "";
  }

  // 空值行只隐藏当页 DOM，不改 Vue 状态，避免与买家筛选用同一份列表互相覆盖。
  function applyRowVisibility(target) {
    for (const card of hiddenCards) {
      if (!card.isConnected) hiddenCards.delete(card);
    }
    const option = currentOption(target);
    const games = Array.isArray(target?.gameList) ? target.gameList : [];
    Array.from(document.querySelectorAll(".gameblock")).forEach((card, index) => {
      const hide = Boolean(option && games[index] && !hasValue(games[index], option.sort));
      card.style.display = hide ? "none" : "";
      if (hide) hiddenCards.add(card);
      else hiddenCards.delete(card);
    });
    updateNote(target);
  }

  function hideNativeControls(toolbar) {
    for (let index = hiddenControls.length - 1; index >= 0; index -= 1) {
      if (!hiddenControls[index].element?.isConnected) hiddenControls.splice(index, 1);
    }
    for (const control of toolbar.querySelectorAll(NATIVE_CONTROL_SELECTOR)) {
      if (!hiddenControls.some((entry) => entry.element === control)) {
        hiddenControls.push({ element: control, display: control.style.display });
      }
      control.style.display = "none";
    }
  }

  function restoreNativeControls() {
    for (const { element, display } of hiddenControls) {
      if (element?.isConnected) element.style.display = display;
    }
    hiddenControls.length = 0;
  }

  function removeSelect() {
    note?.remove();
    note = null;
    select?.remove();
    select = null;
  }

  function valueForState(target) {
    const sort = target?.searchForm?.sort;
    const order = target?.searchForm?.order;
    return SORT_OPTIONS.find((option) => option.sort === sort && option.order === order)?.value ?? null;
  }

  function syncSelect(target) {
    if (!select) return;
    const value = valueForState(target);
    if (value) select.value = value;
  }

  function applyOption(value) {
    const option = SORT_OPTIONS.find((item) => item.value === value);
    const target = vm;
    if (!option || !target) return;
    if (advancedFilter?.isActive?.()) advancedFilter.deactivate();
    const nativeMethod = option.method ? target[option.method] : null;
    if (typeof nativeMethod === "function") {
      nativeMethod.call(target, 0);
      syncSelect(target);
      log("info", "sort_applied", { value, native: true });
      return;
    }
    for (const flag of NATIVE_FLAGS) {
      if (flag in target) target[flag] = false;
    }
    if (!target.searchForm) return;
    target.searchForm.sort = option.sort;
    target.searchForm.order = option.order;
    target.searchForm.pageNumber = option.order === "asc" ? estimatePage(target, option) : 1;
    syncSelect(target);
    target.getGameList?.();
    log("info", "sort_applied", {
      value,
      native: false,
      sort: option.sort,
      order: option.order,
      pageNumber: target.searchForm.pageNumber,
    });
  }

  function buildSelect(toolbar) {
    removeSelect();
    const element = document.createElement("select");
    element.id = SELECT_ID;
    element.style.cssText = "height:.3rem;min-width:1.5rem;padding:0 .06rem;border:1px solid #dcdee2;border-radius:.04rem;background:#fff;color:#17233d;font-size:.13rem;margin-left:.05rem;";
    for (const option of SORT_OPTIONS) {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      element.append(item);
    }
    element.addEventListener("change", () => {
      applyOption(element.value);
    });
    const anchor = toolbar.querySelector(NATIVE_CONTROL_SELECTOR);
    toolbar.insertBefore(element, anchor);
    select = element;
    const hint = document.createElement("span");
    hint.id = NOTE_ID;
    hint.hidden = true;
    hint.style.cssText = "margin-left:.06rem;font-size:.12rem;color:#ed4014;";
    element.after(hint);
    note = hint;
  }

  function mount(nextVm) {
    if (nextVm) vm = nextVm;
    if (!enabled || !vm) return false;
    const toolbar = document.querySelector(TOOLBAR_SELECTOR);
    if (!toolbar) return false;
    if (!select?.isConnected) buildSelect(toolbar);
    hideNativeControls(toolbar);
    syncSelect(vm);
    applyRowVisibility(vm);
    learnPage(vm, currentOption(vm), Number(vm.searchForm?.pageNumber) || 1, vm.gameList);
    return true;
  }

  function unmount() {
    removeSelect();
    restoreNativeControls();
    for (const card of hiddenCards) {
      if (card.isConnected) card.style.display = "";
    }
    hiddenCards.clear();
  }

  function cleanup() {
    unmount();
    vm = null;
  }

  function registerMenu() {
    const stateLabel = enabled ? "已开启（点击关闭）" : "已关闭（点击开启）";
    registerMenuCommand(`排序下拉框：${stateLabel}`, toggleEnabled, { id: MENU_ID });
  }

  function toggleEnabled() {
    enabled = !enabled;
    setValue(ENABLED_STORAGE_KEY, enabled);
    if (enabled) mount(vm);
    else unmount();
    registerMenu();
    log("info", "sort_select_toggled", { enabled });
  }

  function registerMenus() {
    if (menusRegistered) return;
    menusRegistered = true;
    registerMenu();
  }

  return { cleanup, mount, registerMenus };
}
