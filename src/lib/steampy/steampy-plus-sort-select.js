const TOOLBAR_SELECTOR = ".tag.flex-row.align-items-center";
const NATIVE_CONTROL_SELECTOR = ":scope > .tagBtn, :scope > .tagBtnTwo";
const SELECT_ID = "steamPyPlusSortSelect";
const ENABLED_STORAGE_KEY = "steamPyPlusSortSelectEnabled";
const MENU_ID = "steam-py-plus-sort-select";
const LOG_PREFIX = "[SteamPy Plus][SortSelect]";
const LOCATE_PAGE_SIZE = 100;
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

  function syncSelect(target) {
    if (!select) return;
    const value = valueForState(target);
    if (value) select.value = value;
  }

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
    const first = await fetchPage(1);
    if (pageHasValue(first, field)) return 1;
    const totalPages = Number(first?.totalPages);
    if (!Number.isFinite(totalPages) || totalPages <= 1) return 1;
    let low = 2;
    let high = totalPages;
    let found = null;
    while (low <= high) {
      if (token !== generation) return null;
      const middle = Math.floor((low + high) / 2);
      const page = await fetchPage(middle);
      if (pageHasValue(page, field)) {
        found = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
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
    return true;
  }

  function unmount() {
    generation += 1;
    removeSelect();
    restoreNativeControls();
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
