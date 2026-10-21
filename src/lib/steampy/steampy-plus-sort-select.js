const TOOLBAR_SELECTOR = ".tag.flex-row.align-items-center";
const NATIVE_CONTROL_SELECTOR = ":scope > .tagBtn, :scope > .tagBtnTwo";
const SELECT_ID = "steamPyPlusSortSelect";
const ENABLED_STORAGE_KEY = "steamPyPlusSortSelectEnabled";
const MENU_ID = "steam-py-plus-sort-select";
const LOG_PREFIX = "[SteamPy Plus][SortSelect]";
const LOCATE_PAGE_SIZE = 100;
const BOUNDARY_STORAGE_KEY = "steamPyPlusSortBoundary";
const BOUNDARY_TTL_MS = 2 * 60 * 1000;
const DEFAULT_NULL_RATIO = 0.093;
const MAX_WALK_STEPS = 12;
const MAX_BACK_STEPS = 2;
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

function pageHasValue(page, field) {
  const content = Array.isArray(page?.content) ? page.content : [];
  return content.some((row) => hasValue(row, field));
}

export function createSteamPySortSelectController({
  client,
  advancedFilter = null,
  getValue = GM_getValue,
  setValue = GM_setValue,
  registerMenuCommand = GM_registerMenuCommand,
} = {}) {
  let enabled = getValue(ENABLED_STORAGE_KEY, false) === true;
  let menusRegistered = false;
  let vm = null;
  let select = null;
  let generation = 0;
  const hiddenControls = [];
  const hiddenCards = new Set();

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
    select?.remove();
    select = null;
  }

  function valueForState(target) {
    const sort = target?.searchForm?.sort;
    const order = target?.searchForm?.order;
    return SORT_OPTIONS.find((option) => option.sort === sort && option.order === order)?.value ?? null;
  }

  // 空值行只隐藏当页 DOM，不改 Vue 状态，避免与买家筛选用同一份列表互相覆盖。
  function applyRowVisibility(target) {
    for (const card of hiddenCards) {
      if (!card.isConnected) hiddenCards.delete(card);
    }
    const state = SORT_OPTIONS.find((option) => !option.method
      && option.sort === target?.searchForm?.sort
      && option.order === target?.searchForm?.order);
    const games = target?.gameList ?? [];
    Array.from(document.querySelectorAll(".gameblock")).forEach((card, index) => {
      const value = state && games[index] ? games[index][state.sort] : null;
      card.style.display = state && (value === null || value === undefined || value === "") ? "none" : "";
      if (card.style.display === "none") hiddenCards.add(card);
      else hiddenCards.delete(card);
    });
  }

  function syncSelect(target) {
    if (!select) return;
    const value = valueForState(target);
    if (value) select.value = value;
  }

  function loadBoundary() {
    const raw = getValue(BOUNDARY_STORAGE_KEY, "");
    if (!raw) return { ratio: DEFAULT_NULL_RATIO, fields: {} };
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const ratio = Number(parsed?.ratio);
      return {
        ratio: Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : DEFAULT_NULL_RATIO,
        fields: parsed?.fields && typeof parsed.fields === "object" ? parsed.fields : {},
      };
    } catch {
      return { ratio: DEFAULT_NULL_RATIO, fields: {} };
    }
  }

  function saveBoundary(boundary) {
    setValue?.(BOUNDARY_STORAGE_KEY, JSON.stringify(boundary));
  }

  // 空值前缀的位置是稳定先验：优先用缓存页与学习到的空值比例直接命中，仅在偏离时小步修正。
  async function locateFirstPageWithValue(target, field, token) {
    const fetchPage = async (pageNumber) => client.fetchSteamGameKeyHot({
      region: target.areas,
      pageNumber,
      pageSize: LOCATE_PAGE_SIZE,
      sort: field,
      order: "asc",
      startDate: "",
      endDate: "",
    });
    const boundary = loadBoundary();
    const cached = boundary.fields?.[field];
    const probes = [];
    const probe = async (pageNumber) => {
      probes.push(pageNumber);
      return fetchPage(pageNumber);
    };
    let found = null;
    let lastNullPage = 0;
    let totalPages = null;
    if (cached && Number.isFinite(Number(cached.page)) && Date.now() - Number(cached.at || 0) < BOUNDARY_TTL_MS) {
      const page = await probe(Number(cached.page));
      if (token !== generation) return null;
      totalPages = Number(page?.totalPages);
      if (pageHasValue(page, field)) found = Number(cached.page);
      else lastNullPage = Number(cached.page);
    }
    if (found === null) {
      const first = await probe(1);
      if (token !== generation) return null;
      totalPages = Number(first?.totalPages);
      if (pageHasValue(first, field)) {
        found = 1;
      } else if (!Number.isFinite(totalPages) || totalPages <= 1) {
        return 1;
      } else {
        const priorPage = cached && Number.isFinite(Number(cached.page))
          ? Number(cached.page)
          : Math.max(1, Math.min(totalPages, Math.round(boundary.ratio * totalPages)));
        if (!probes.includes(priorPage)) {
          const page = await probe(priorPage);
          if (token !== generation) return null;
          if (pageHasValue(page, field)) found = priorPage;
          else lastNullPage = Math.max(lastNullPage, priorPage);
        }
        if (found === null) {
          const step = Math.max(1, Math.ceil(totalPages / 50));
          for (let walk = 0; walk < MAX_WALK_STEPS; walk += 1) {
            const next = Math.min(totalPages, Math.max(lastNullPage, 1) + step * (walk + 1));
            const page = await probe(next);
            if (token !== generation) return null;
            if (pageHasValue(page, field)) {
              found = next;
              break;
            }
            lastNullPage = next;
            if (next >= totalPages) break;
          }
        }
      }
    }
    if (found === null) {
      log("error", "sort_locate_exhausted", { field, probes: probes.length });
      return null;
    }
    for (let back = 0; back < MAX_BACK_STEPS && found > 1; back += 1) {
      const page = await probe(found - 1);
      if (token !== generation) return null;
      if (!pageHasValue(page, field)) break;
      found -= 1;
    }
    if (Number.isFinite(totalPages) && totalPages > 0) {
      boundary.ratio = Math.min(0.9, Math.max(0.001, (found - 1) / totalPages));
      boundary.fields[field] = { page: found, totalPages, at: Date.now() };
      saveBoundary(boundary);
    }
    log("info", "sort_located", { field, page: found, probes: probes.length });
    return found;
  }

  async function applyOption(value) {
    const option = SORT_OPTIONS.find((item) => item.value === value);
    const target = vm;
    if (!option || !target) return;
    const token = ++generation;
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
    let pageNumber = 1;
    if (option.order === "asc") {
      try {
        const located = await locateFirstPageWithValue(target, option.sort, token);
        if (token !== generation) return;
        if (located) {
          // 定位按固定页大小完成，换算成当前列表页大小对应的页码。
          const firstIndex = (located - 1) * LOCATE_PAGE_SIZE;
          const pageSize = Number(target.searchForm?.pageSize) || 1;
          pageNumber = Math.floor(firstIndex / pageSize) + 1;
        }
      } catch (error) {
        log("error", "sort_locate_failed", { field: option.sort, message: error?.message || String(error) });
      }
    }
    if (token !== generation) return;
    if (!target.searchForm) return;
    target.searchForm.sort = option.sort;
    target.searchForm.order = option.order;
    target.searchForm.pageNumber = pageNumber;
    syncSelect(target);
    target.getGameList?.();
    log("info", "sort_applied", { value, native: false, sort: option.sort, order: option.order, pageNumber });
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
      void applyOption(element.value);
    });
    const anchor = toolbar.querySelector(NATIVE_CONTROL_SELECTOR);
    toolbar.insertBefore(element, anchor);
    select = element;
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
    return true;
  }

  function unmount() {
    generation += 1;
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
