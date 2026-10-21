const TOOLBAR_SELECTOR = ".tag.flex-row.align-items-center";
const NATIVE_CONTROL_SELECTOR = ":scope > .tagBtn, :scope > .tagBtnTwo";
const SELECT_ID = "steamPyPlusSortSelect";
const DIRECTION_ID = "steamPyPlusSortDirection";
const NOTE_ID = "steamPyPlusSortNote";
const ENABLED_STORAGE_KEY = "steamPyPlusSortSelectEnabled";
const PREFERENCE_STORAGE_KEY = "steamPyPlusSortPreference";
const LEARNING_STORAGE_KEY = "steamPyPlusSortLearning";
const MENU_ID = "steam-py-plus-sort-select";
const LOG_PREFIX = "[SteamPy Plus][SortSelect]";
// 空值前缀约占列表前 9%，来自实测；学习只会把比例与空值页向上修正。
const DEFAULT_NULL_RATIO = 0.093;
const NATIVE_FLAGS = ["chooseOne", "chooseTwo", "chooseThree", "chooseFour", "chooseFive"];
const DIRECTION_LABEL = { asc: "升序 ↑", desc: "降序 ↓" };

// nullPrefix 表示该字段升序时接口把空值排在最前，需要跳到有值页。
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

  function loadLearning() {
    const raw = getValue(LEARNING_STORAGE_KEY, "");
    if (!raw) return { ratio: DEFAULT_NULL_RATIO, nullPages: {} };
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const ratio = Number(parsed?.ratio);
      return {
        ratio: Number.isFinite(ratio) && ratio >= DEFAULT_NULL_RATIO && ratio < 0.9 ? ratio : DEFAULT_NULL_RATIO,
        nullPages: parsed?.nullPages && typeof parsed.nullPages === "object" ? parsed.nullPages : {},
        normalPages: parsed?.normalPages && typeof parsed.normalPages === "object" ? parsed.normalPages : {},
      };
    } catch {
      return { ratio: DEFAULT_NULL_RATIO, nullPages: {}, normalPages: {} };
    }
  }

  function saveLearning(learning) {
    setValue?.(LEARNING_STORAGE_KEY, JSON.stringify(learning));
  }

  function rememberNormalPages(target) {
    const pageSize = Number(target?.searchForm?.pageSize) || 30;
    const totalElements = Number(target?.total) || 0;
    const pages = Math.max(Number(target?.totalPage) || 0, totalElements > 0 ? Math.ceil(totalElements / pageSize) : 0);
    if (pages <= 0) return;
    const learning = loadLearning();
    learning.normalPages = learning.normalPages || {};
    learning.normalPages[target?.areas || "cn"] = pages;
    saveLearning(learning);
  }

  function learningKey(target, field) {
    return `${target?.areas || "cn"}:${field}:${Number(target?.searchForm?.pageSize) || 30}`;
  }

  // 只用已观察结果推导落点：记住最后一个空值页，比例只增不减，避免旧观测回退。
  function estimatePage(target, field, useNormalPages = false) {
    const learning = loadLearning();
    const pageSize = Number(target?.searchForm?.pageSize) || 30;
    const totalElements = Number(target?.total) || 0;
    const derivedPages = totalElements > 0 ? Math.ceil(totalElements / pageSize) : 0;
    const region = target?.areas || "cn";
    // 高级筛选的列表条数与常规列表不同：从高级筛选切回时必须只用常规页数记忆。
    const remembered = Number(learning.normalPages?.[region]) || 0;
    // 站点字段可能滞后，取较大值避免低估而落回空值区。
    const totalPages = useNormalPages && remembered > 0
      ? remembered
      : Math.max(Number(target?.totalPage) || 0, derivedPages);
    const nullPage = Number(learning.nullPages?.[learningKey(target, field)]) || 0;
    if (totalPages <= 0) return Math.max(1, nullPage + 1);
    const ratioPage = Math.max(1, Math.min(totalPages, Math.round(learning.ratio * totalPages)));
    const step = Math.max(1, Math.round(totalPages * 0.02));
    const fromNullPage = nullPage >= ratioPage ? nullPage + step : 0;
    return Math.max(1, Math.min(totalPages, Math.max(ratioPage, nullPage + 1, fromNullPage)));
  }

  function learnPage(target, field, currentPage, games) {
    if (!target || !field?.nullPrefix || target?.searchForm?.order !== "asc") return;
    if (!Array.isArray(games) || games.length === 0) return;
    if (games.some((game) => hasValue(game, field.value))) return;
    const key = learningKey(target, field.value);
    const learning = loadLearning();
    learning.nullPages[key] = Math.max(Number(learning.nullPages[key]) || 0, currentPage);
    const totalPages = Number(target.totalPage) || 0;
    if (totalPages > 0) {
      learning.ratio = Math.max(learning.ratio, Math.min(0.9, currentPage / totalPages));
    }
    saveLearning(learning);
  }

  // 分页控件保留 1、2、3… 的“相对页码”，只在请求时加上空值区偏移；
  // 同时把 total 减去被跳过的条数，使页数与相对页码一致。
  let pagination = { vm: null, offset: 0, originals: null, absoluteTotal: 0, appliedTotal: 0 };

  function restoreTotal(target) {
    if (target && pagination.appliedTotal > 0 && Number(target.total) === pagination.appliedTotal) {
      target.total = pagination.absoluteTotal;
    }
  }

  function clearPagination() {
    const { vm: target, originals } = pagination;
    if (target && originals) {
      target.getGameList = originals.getGameList;
      restoreTotal(target);
    }
    pagination = { vm: null, offset: 0, originals: null, absoluteTotal: 0, appliedTotal: 0 };
  }

  function syncPaginationTotal(target) {
    if (!target || pagination.vm !== target || !pagination.offset) return;
    const pageSize = Number(target.searchForm?.pageSize) || 30;
    const current = Number(target.total) || 0;
    if (pagination.appliedTotal > 0 && current === pagination.appliedTotal) return;
    pagination.absoluteTotal = current;
    pagination.appliedTotal = Math.max(0, current - pagination.offset * pageSize);
    target.total = pagination.appliedTotal;
  }

  function applyPagination(target, offset) {
    if (!target) return;
    if (pagination.vm === target && pagination.offset === offset) return;
    clearPagination();
    if (!offset) return;
    const originals = { getGameList: target.getGameList };
    pagination = { vm: target, offset, originals, absoluteTotal: 0, appliedTotal: 0 };
    target.getGameList = function pagedGetGameList(...args) {
      const form = this.searchForm;
      if (!form || !pagination.offset) return originals.getGameList.apply(this, args);
      const relative = Number(form.pageNumber) || 1;
      form.pageNumber = relative + pagination.offset;
      try {
        return originals.getGameList.apply(this, args);
      } finally {
        form.pageNumber = relative;
      }
    };
  }

  function loadPreference() {
    const raw = getValue(PREFERENCE_STORAGE_KEY, "");
    if (!raw) return null;
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const field = SORT_FIELDS.find((item) => item.value === parsed?.field);
      const order = parsed?.order === "asc" ? "asc" : "desc";
      return field ? { field, order } : null;
    } catch {
      return null;
    }
  }

  function savePreference(field, order) {
    setValue?.(PREFERENCE_STORAGE_KEY, JSON.stringify({ field: field.value, order }));
  }

  // 刷新或从其他页面回来时恢复上次的字段与方向，每个买家实例只恢复一次。
  function restorePreference(target) {
    if (!target || target.__steamPyPlusSortRestored) return;
    target.__steamPyPlusSortRestored = true;
    if (advancedFilter?.isActive?.()) return;
    const preference = loadPreference();
    if (!preference) return;
    const current = target.searchForm;
    if (current?.sort === preference.field.value && current?.order === preference.order) return;
    applySort(preference.field, preference.order);
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
    const wasAdvanced = advancedFilter?.isActive?.() === true;
    if (wasAdvanced) advancedFilter.deactivate();
    for (const flag of NATIVE_FLAGS) {
      if (flag in target) target[flag] = false;
    }
    const useNullPrefix = field.nullPrefix && order === "asc";
    // 先撤销上一轮的偏移与 total 调整，再按真实总数估算落点。
    clearPagination();
    const basePage = useNullPrefix ? estimatePage(target, field.value, wasAdvanced) : 1;
    target.searchForm.sort = field.value;
    target.searchForm.order = order;
    target.searchForm.pageNumber = 1;
    savePreference(field, order);
    applyPagination(target, useNullPrefix ? Math.max(0, basePage - 1) : 0);
    syncPaginationTotal(target);
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
    if (currentField(vm)) rememberNormalPages(vm);
    syncPaginationTotal(vm);
    learnPage(
      vm,
      currentField(vm),
      (Number(vm.searchForm?.pageNumber) || 1) + (pagination.vm === vm ? pagination.offset : 0),
      vm.gameList,
    );
    restorePreference(vm);
    return true;
  }

  function unmount() {
    clearPagination();
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
