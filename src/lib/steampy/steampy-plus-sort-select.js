const TOOLBAR_SELECTOR = ".tag.flex-row.align-items-center";
const NATIVE_CONTROL_SELECTOR = ":scope > .tagBtn, :scope > .tagBtnTwo";
const SELECT_ID = "steamPyPlusSortSelect";
const DIRECTION_ID = "steamPyPlusSortDirection";
const NOTE_ID = "steamPyPlusSortNote";
const ENABLED_STORAGE_KEY = "steamPyPlusSortSelectEnabled";
const BOUNDARY_STORAGE_KEY = "steamPyPlusSortBoundary";
const MENU_ID = "steam-py-plus-sort-select";
const LOG_PREFIX = "[SteamPy Plus][SortSelect]";
// 空值前缀约占列表前 9%，来自实测；学习后的比例会覆盖它，区域差异靠翻页观察校正。
const DEFAULT_NULL_RATIO = 0.093;
const NATIVE_FLAGS = ["chooseOne", "chooseTwo", "chooseThree", "chooseFour", "chooseFive"];
const DIRECTION_LABEL = { asc: "升序 ↑", desc: "降序 ↓" };

// nullPrefix 表示该字段升序时接口把空值排在最前，需要先落到有值页。
const SORT_FIELDS = Object.freeze([
  { value: "createTime", label: "最新", defaultOrder: "desc" },
  { value: "cdkCount", label: "周销量", defaultOrder: "desc" },
  { value: "keyTx", label: "销量", defaultOrder: "desc" },
  { value: "keyDiscount", label: "折扣", defaultOrder: "asc" },
  { value: "keyPrice", label: "价格", defaultOrder: "asc" },
  { value: "keyTxAmt", label: "实付价", defaultOrder: "asc", nullPrefix: true },
  { value: "keyAveAmt", label: "成交均价", defaultOrder: "asc", nullPrefix: true },
  { value: "rating", label: "好评率", defaultOrder: "desc", nullPrefix: true },
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

function flipOrder(order) {
  return order === "asc" ? "desc" : "asc";
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
  let direction = null;
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

  // 只用已观察结果推导落点：有值页与空值页各自记忆，不发探测请求。
  function estimatePage(target, field) {
    const boundary = loadBoundary();
    const learning = boundary.fields?.[boundaryKey(target, field)] || {};
    const totalPages = Number(target?.totalPage) || 0;
    const valuePage = Number(learning.valuePage);
    const nullPage = Number(learning.nullPage);
    // 有值页必须晚于空值页，否则视为旧观测作废。
    if (Number.isFinite(valuePage) && (!Number.isFinite(nullPage) || valuePage > nullPage)) return valuePage;
    if (Number.isFinite(nullPage)) return Math.max(1, nullPage + 1);
    if (totalPages > 0) return Math.max(1, Math.min(totalPages, Math.round(boundary.ratio * totalPages)));
    return 1;
  }

  function learnPage(target, field, currentPage, games) {
    if (!target || !field?.nullPrefix || target?.searchForm?.order !== "asc") return;
    if (!Array.isArray(games) || games.length === 0) return;
    const key = boundaryKey(target, field.value);
    const boundary = loadBoundary();
    const learning = boundary.fields[key] || {};
    const priced = games.filter((game) => hasValue(game, field.value)).length;
    const knownValuePage = Number(learning.valuePage);
    const knownNullPage = Number(learning.nullPage);
    if (priced === 0) {
      learning.nullPage = Math.max(Number.isFinite(knownNullPage) ? knownNullPage : 0, currentPage);
      if (Number.isFinite(knownValuePage) && knownValuePage <= learning.nullPage) delete learning.valuePage;
    } else {
      const reusable = Number.isFinite(knownValuePage)
        && (!Number.isFinite(knownNullPage) || knownValuePage > knownNullPage)
        ? Math.min(knownValuePage, currentPage)
        : currentPage;
      learning.valuePage = reusable;
      const totalPages = Number(target.totalPage) || 0;
      if (totalPages > 0) boundary.ratio = Math.min(0.9, Math.max(0.001, currentPage / totalPages));
    }
    learning.at = Date.now();
    boundary.fields[key] = learning;
    saveBoundary(boundary);
  }

  function currentField(target) {
    const sort = target?.searchForm?.sort;
    return SORT_FIELDS.find((field) => field.value === sort) || null;
  }

  function activeNullPrefix(target) {
    const field = currentField(target);
    if (!field?.nullPrefix || target?.searchForm?.order !== "asc") return null;
    return field;
  }

  function updateNote(target) {
    if (!note) return;
    const field = activeNullPrefix(target);
    const games = Array.isArray(target?.gameList) ? target.gameList : [];
    const emptyPage = Boolean(field && games.length > 0 && !games.some((game) => hasValue(game, field.value)));
    note.hidden = !emptyPage;
    note.textContent = emptyPage ? "本页无成交价数据，翻到下一页查看" : "";
  }

  // 空值行只隐藏当页 DOM，不改 Vue 状态，避免与买家筛选用同一份列表互相覆盖。
  function applyRowVisibility(target) {
    for (const card of hiddenCards) {
      if (!card.isConnected) hiddenCards.delete(card);
    }
    const field = activeNullPrefix(target);
    const games = Array.isArray(target?.gameList) ? target.gameList : [];
    Array.from(document.querySelectorAll(".gameblock")).forEach((card, index) => {
      const hide = Boolean(field && games[index] && !hasValue(games[index], field.value));
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

  function removeControls() {
    note?.remove();
    note = null;
    direction?.remove();
    direction = null;
    select?.remove();
    select = null;
  }

  function syncControls(target) {
    if (!select) return;
    const field = currentField(target);
    const order = target?.searchForm?.order === "asc" ? "asc" : "desc";
    if (field) select.value = field.value;
    direction.textContent = DIRECTION_LABEL[order];
    direction.dataset.order = order;
    direction.disabled = !field;
    direction.title = field ? `按${field.label}${order === "asc" ? "升序" : "降序"}排列` : "";
  }

  function applySort(field, order) {
    const target = vm;
    if (!field || !target?.searchForm) return;
    if (advancedFilter?.isActive?.()) advancedFilter.deactivate();
    for (const flag of NATIVE_FLAGS) {
      if (flag in target) target[flag] = false;
    }
    const useNullPrefix = field.nullPrefix && order === "asc";
    target.searchForm.sort = field.value;
    target.searchForm.order = order;
    target.searchForm.pageNumber = useNullPrefix ? estimatePage(target, field.value) : 1;
    syncControls(target);
    target.getGameList?.();
    log("info", "sort_applied", {
      field: field.value,
      order,
      pageNumber: target.searchForm.pageNumber,
      nullPrefix: useNullPrefix,
    });
  }

  function buildControls(toolbar) {
    removeControls();
    const element = document.createElement("select");
    element.id = SELECT_ID;
    element.style.cssText = "height:.3rem;min-width:1.15rem;padding:0 .06rem;border:1px solid #dcdee2;border-radius:.04rem;background:#fff;color:#17233d;font-size:.13rem;margin-left:.05rem;";
    for (const field of SORT_FIELDS) {
      const item = document.createElement("option");
      item.value = field.value;
      item.textContent = field.label;
      element.append(item);
    }
    element.addEventListener("change", () => {
      const field = SORT_FIELDS.find((item) => item.value === element.value);
      applySort(field, field?.defaultOrder);
    });
    const anchor = toolbar.querySelector(NATIVE_CONTROL_SELECTOR);
    toolbar.insertBefore(element, anchor);
    select = element;

    const toggle = document.createElement("button");
    toggle.id = DIRECTION_ID;
    toggle.type = "button";
    toggle.className = "ivu-btn ivu-btn-default ivu-btn-sm";
    toggle.style.cssText = "margin-left:.05rem;min-width:.62rem;";
    toggle.textContent = DIRECTION_LABEL.desc;
    toggle.dataset.order = "desc";
    toggle.addEventListener("click", () => {
      const field = currentField(vm) || SORT_FIELDS.find((item) => item.value === select?.value);
      if (!field) return;
      const current = vm?.searchForm?.order === "asc" ? "asc" : "desc";
      applySort(field, flipOrder(current));
    });
    element.after(toggle);
    direction = toggle;

    const hint = document.createElement("span");
    hint.id = NOTE_ID;
    hint.hidden = true;
    hint.style.cssText = "margin-left:.06rem;font-size:.12rem;color:#ed4014;";
    toggle.after(hint);
    note = hint;
  }

  function mount(nextVm) {
    if (nextVm) vm = nextVm;
    if (!enabled || !vm) return false;
    const toolbar = document.querySelector(TOOLBAR_SELECTOR);
    if (!toolbar) return false;
    if (!select?.isConnected) buildControls(toolbar);
    hideNativeControls(toolbar);
    syncControls(vm);
    applyRowVisibility(vm);
    learnPage(vm, currentField(vm), Number(vm.searchForm?.pageNumber) || 1, vm.gameList);
    return true;
  }

  function unmount() {
    removeControls();
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
