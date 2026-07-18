const FILTER_ANCHOR_SELECTOR = ".tag.flex-row.align-items-center";
const DLC_CONTROL_SELECTOR = "#steamPyPlusHideDlc";
const ADVANCED_BUTTON_ID = "steamPyPlusAdvancedFilterButton";
const ADVANCED_DIALOG_ID = "steamPyPlusAdvancedFilterDialog";
const FIXED_SORT = "sp.keyDaily";
const FIXED_ORDER = "desc";

const SUPPORTED_FILTERS = Object.freeze([
  ["lowAmt", "highAmt", "decRange"],
  ["lowDis", "highDis", "decRange"],
  ["hisFlag", null, "str"],
  ["lowVs", "highVs", "decRange"],
  ["kd", null, "int"],
  ["genre", null, "str"],
  ["releaseDay", null, "int"],
  ["reviewScoreDesc", null, "str"],
  ["lowRating", "highRating", "decRange"],
  ["lowReview", "highReview", "intRange"],
  ["lang", null, "str"],
  ["familySharing", null, "str"],
  ["deckVerified", null, "str"],
  ["cards", null, "str"],
  ["publisher", null, "str"],
]);

const SUPPORTED_BY_CODE = new Map(SUPPORTED_FILTERS.map(([code, highCode, type]) => [code, { highCode, type }]));

function createAbortError() {
  const error = new Error("高级筛选请求已取消");
  error.name = "AbortError";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function isVisible(item) {
  return item?.showFlag === "1";
}

function compareSortOrder(first, second) {
  return Number(first?.sortOrder) - Number(second?.sortOrder);
}

function createEmptyState() {
  return Object.create(null);
}

function copyState(state) {
  return Object.assign(createEmptyState(), state);
}

function validNumber(value) {
  return value !== "" && value !== null && value !== undefined && Number.isFinite(Number(value));
}

function formatRequestValue(value, type) {
  if (!validNumber(value)) return "";
  return type === "decRange"
    ? Number(value).toFixed(2)
    : String(Math.trunc(Number(value)));
}

function formatValue(value) {
  return validNumber(value) ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(Number(value)) : "";
}

function formatOption(option, type) {
  if (option.label) return option.label;
  if (type === "str") return String(option.strValue ?? "");
  if (type === "int") return formatValue(option.lowValue);
  return `${formatValue(option.lowValue)} - ${formatValue(option.highValue)}`;
}

function normalizeMetadata(result) {
  if (!Array.isArray(result)) return [];
  return result
    .filter((group) => isVisible(group) && SUPPORTED_BY_CODE.has(group.code))
    .map((group) => {
      const supported = SUPPORTED_BY_CODE.get(group.code);
      if (group.type !== supported.type || (supported.highCode && group.highCode !== supported.highCode)) return null;
      return {
        ...group,
        options: Array.isArray(group.options)
          ? group.options.filter(isVisible).sort(compareSortOrder)
          : [],
      };
    })
    .filter(Boolean)
    .sort(compareSortOrder);
}

function hasCompleteMetadata(metadata) {
  if (metadata.length !== SUPPORTED_FILTERS.length) return false;
  const codes = new Set(metadata.map((group) => group.code));
  return SUPPORTED_FILTERS.every(([code]) => codes.has(code));
}

function mapSteamApp(item, markedItems, markedAppIds) {
  const mapped = { ...item };
  if (Object.hasOwn(item, "miniPrice")) mapped.keyPrice = item.miniPrice;
  if (validNumber(item.oriPrice) && Number(item.oriPrice) > 0 && validNumber(item.miniPrice)) {
    mapped.keyDiscount = Number(item.miniPrice) / Number(item.oriPrice);
  } else {
    delete mapped.keyDiscount;
  }
  markedItems.add(mapped);
  if (mapped.appId !== null && mapped.appId !== undefined) markedAppIds.add(String(mapped.appId));
  return mapped;
}

export function createSteamPyAdvancedFilterController({
  fetchFilterMetadata,
  fetchSteamAppList,
  fetchSteamGameByAppId,
  setHideDlcSuspended = () => {},
}) {
  let vm = null;
  let originalMethods = null;
  let button = null;
  let dialog = null;
  let metadata = [];
  let draft = createEmptyState();
  let applied = createEmptyState();
  let active = false;
  let mountToken = 0;
  const requestGenerations = { detail: 0, list: 0, metadata: 0 };
  let pausedDlcControl = null;
  const requests = new Set();
  const mappedItems = new WeakSet();
  const mappedAppIds = new Set();

  function showError(message) {
    if (vm?.$Message?.error) vm.$Message.error(message);
    else if (vm?.$message?.error) vm.$message.error(message);
    else console.error(`[SteamPy Plus] ${message}`);
  }

  function currentRequest(token, kind, generation) {
    return vm && token === mountToken && generation === requestGenerations[kind];
  }

  async function request(kind, callback, token) {
    const controller = new AbortController();
    const generation = ++requestGenerations[kind];
    requests.add(controller);
    try {
      const result = await callback(controller.signal);
      if (controller.signal.aborted || !currentRequest(token, kind, generation)) throw createAbortError();
      return result;
    } catch (error) {
      if (controller.signal.aborted || !currentRequest(token, kind, generation)) throw createAbortError();
      throw error;
    } finally {
      requests.delete(controller);
    }
  }

  function pauseDlcFilter() {
    if (pausedDlcControl) return;
    const control = document.querySelector(DLC_CONTROL_SELECTOR);
    pausedDlcControl = control ? {
      control,
      checked: control.checked,
      disabled: control.disabled,
      hadTitle: control.hasAttribute("title"),
      title: control.getAttribute("title"),
    } : {};
    if (control) {
      control.disabled = true;
      control.title = "高级筛选接口不返回 DLC 类型";
    }
    setHideDlcSuspended(true);
  }

  function resumeDlcFilter() {
    if (!pausedDlcControl) return;
    setHideDlcSuspended(false);
    const { control, checked, disabled, hadTitle, title } = pausedDlcControl;
    if (control?.isConnected) {
      control.checked = checked;
      control.disabled = disabled;
      if (hadTitle) control.setAttribute("title", title);
      else control.removeAttribute("title");
    }
    pausedDlcControl = null;
  }

  function createParams(source) {
    const params = {
      pageNumber: source?.pageNumber,
      pageSize: source?.pageSize,
      sort: FIXED_SORT,
      order: FIXED_ORDER,
    };
    SUPPORTED_FILTERS.forEach(([code, highCode]) => {
      params[code] = "";
      if (highCode) params[highCode] = "";
    });
    metadata.forEach((group) => {
      const optionIndex = applied[group.code];
      if (!Number.isInteger(optionIndex)) return;
      const option = group.options[optionIndex];
      if (!option) return;
      if (group.type === "decRange" || group.type === "intRange") {
        params[group.code] = formatRequestValue(option.lowValue, group.type);
        params[group.highCode] = formatRequestValue(option.highValue, group.type);
      } else if (group.type === "str") {
        params[group.code] = String(option.strValue ?? "");
      } else if (group.type === "int") {
        params[group.code] = formatRequestValue(option.lowValue, group.type);
      }
    });
    return params;
  }

  function refresh(pageNumber = 1) {
    if (!vm?.getGameList) return;
    if (vm.searchForm) vm.searchForm.pageNumber = pageNumber;
    vm.getGameList();
  }

  async function advancedCdkListApi(searchForm) {
    const token = mountToken;
    try {
      const result = await request(
        "list",
        () => fetchSteamAppList(createParams(searchForm)),
      token,
      );
      if (!Array.isArray(result?.content)) throw new Error("高级筛选返回的数据格式无效");
      mappedAppIds.clear();
      return {
        success: true,
        result: {
          ...result,
          content: result.content.map((item) => mapSteamApp(item, mappedItems, mappedAppIds)),
        },
      };
    } catch (error) {
      if (!isAbortError(error)) showError(error.message || "加载高级筛选结果失败");
      throw error;
    }
  }

  async function advancedGoDetail(index) {
    const game = vm?.gameList?.[index];
    const hasAppId = game?.appId !== null && game?.appId !== undefined;
    const mapped = mappedItems.has(game) || (hasAppId && mappedAppIds.has(String(game.appId)));
    if (!mapped) return originalMethods.goDetail.call(vm, index);
    if (game && typeof game === "object") mappedItems.add(game);
    try {
      const token = mountToken;
      const result = await request("detail", () => fetchSteamGameByAppId(game.appId), token);
      const gameId = result?.content?.[0]?.id;
      if (!gameId) throw new Error("未找到对应的 SteamPy 商品");
      vm.$router.push({ name: "cdkDetail", query: { name: vm.areas, gameId } });
    } catch (error) {
      if (!isAbortError(error)) showError(error.message || "打开商品详情失败");
    }
  }

  function patchVm() {
    originalMethods = {
      cdkListApi: vm.cdkListApi,
      chooseTag: vm.chooseTag,
      goDetail: vm.goDetail,
      sort: vm.searchForm?.sort,
      order: vm.searchForm?.order,
    };
    if (vm.searchForm) {
      vm.searchForm.sort = FIXED_SORT;
      vm.searchForm.order = FIXED_ORDER;
    }
    vm.cdkListApi = advancedCdkListApi;
    vm.chooseTag = function advancedChooseTag(...args) {
      const chooseTag = originalMethods?.chooseTag;
      disable({ refreshList: false });
      return chooseTag?.apply(this, args);
    };
    vm.goDetail = advancedGoDetail;
  }

  function restoreVm() {
    if (!vm || !originalMethods) return;
    vm.cdkListApi = originalMethods.cdkListApi;
    vm.chooseTag = originalMethods.chooseTag;
    vm.goDetail = originalMethods.goDetail;
    if (vm.searchForm) {
      vm.searchForm.sort = originalMethods.sort;
      vm.searchForm.order = originalMethods.order;
    }
    originalMethods = null;
  }

  function disable({ refreshList }) {
    if (!active) return;
    active = false;
    Object.keys(requestGenerations).forEach((key) => { requestGenerations[key] += 1; });
    requests.forEach((controller) => controller.abort());
    restoreVm();
    resumeDlcFilter();
    if (refreshList) refresh(1);
  }

  function closeDialog() {
    dialog?.remove();
    dialog = null;
  }

  function renderDialog() {
    if (!dialog) return;
    const body = dialog.querySelector("[data-steam-py-plus-advanced-body]");
    body.replaceChildren();
    metadata.forEach((group) => {
      const field = document.createElement("label");
      field.style.cssText = "display:flex;align-items:center;gap:.08rem;min-width:2.6rem;";
      const title = document.createElement("span");
      title.textContent = group.name;
      const select = document.createElement("select");
      select.dataset.steamPyPlusFilterCode = group.code;
      select.style.cssText = "flex:1;min-width:1.4rem;height:.3rem;border:1px solid #dcdee2;border-radius:.04rem;background:#fff;";
      const unlimited = document.createElement("option");
      unlimited.value = "";
      unlimited.textContent = "不限";
      select.append(unlimited);
      group.options.forEach((option, index) => {
        const item = document.createElement("option");
        item.value = String(index);
        item.textContent = formatOption(option, group.type);
        select.append(item);
      });
      const selected = draft[group.code];
      select.value = Number.isInteger(selected) ? String(selected) : "";
      select.addEventListener("change", () => {
        if (select.value === "") delete draft[group.code];
        else draft[group.code] = Number(select.value);
      });
      field.append(title, select);
      body.append(field);
    });
  }

  async function loadMetadata() {
    if (metadata.length) return true;
    try {
      const token = mountToken;
      const nextMetadata = normalizeMetadata(await request("metadata", () => fetchFilterMetadata(), token));
      if (!hasCompleteMetadata(nextMetadata)) throw new Error("高级筛选条件不完整，请稍后重试");
      metadata = nextMetadata;
      return true;
    } catch (error) {
      if (!isAbortError(error)) showError(error.message || "加载高级筛选条件失败");
      return false;
    }
  }

  async function openDialog() {
    if (dialog) return;
    const overlay = document.createElement("div");
    overlay.id = ADVANCED_DIALOG_ID;
    overlay.style.cssText = "position:fixed;z-index:10000;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.38);";
    const panel = document.createElement("section");
    panel.style.cssText = "width:min(7.4rem,92vw);max-height:82vh;overflow:auto;padding:.22rem;border-radius:.08rem;background:#fff;color:#17233d;box-sizing:border-box;";
    const title = document.createElement("h3");
    title.textContent = "高级筛选";
    title.style.cssText = "margin:0 0:.16rem;font-size:.18rem;";
    const body = document.createElement("div");
    body.dataset.steamPyPlusAdvancedBody = "true";
    body.style.cssText = "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.12rem;";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:.1rem;margin-top:.2rem;";
    const makeButton = (text, handler) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "ivu-btn ivu-btn-default";
      element.textContent = text;
      element.addEventListener("click", handler);
      return element;
    };
    const cancel = makeButton("取消", () => closeDialog());
    const reset = makeButton("重置", () => {
      draft = createEmptyState();
      renderDialog();
    });
    const exit = makeButton("关闭高级筛选", () => {
      disable({ refreshList: true });
      closeDialog();
    });
    const apply = makeButton("应用", () => {
      applied = copyState(draft);
      if (!active) {
        active = true;
        pauseDlcFilter();
        patchVm();
      }
      refresh(1);
      closeDialog();
    });
    apply.className = "ivu-btn ivu-btn-primary";
    apply.disabled = true;
    actions.append(cancel, reset, exit, apply);
    panel.append(title, body, actions);
    overlay.append(panel);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeDialog();
    });
    document.body.append(overlay);
    dialog = overlay;
    draft = copyState(applied);
    if (await loadMetadata()) {
      renderDialog();
      apply.disabled = false;
    }
  }

  function mount(nextVm) {
    if (!nextVm || typeof nextVm.getGameList !== "function") return false;
    if (vm && vm !== nextVm) cleanup();
    if (vm !== nextVm) mountToken += 1;
    vm = nextVm;
    const anchor = document.querySelector(FILTER_ANCHOR_SELECTOR);
    if (!anchor) return false;
    if (button?.isConnected) return true;
    document.getElementById(ADVANCED_BUTTON_ID)?.remove();
    button = document.createElement("button");
    button.id = ADVANCED_BUTTON_ID;
    button.type = "button";
    button.className = "ivu-btn ivu-btn-default ivu-btn-sm";
    button.textContent = "高级筛选";
    button.style.cssText = "margin-left:.08rem;";
    button.addEventListener("click", () => { openDialog(); });
    anchor.append(button);
    return true;
  }

  function cleanup() {
    mountToken += 1;
    Object.keys(requestGenerations).forEach((key) => { requestGenerations[key] += 1; });
    requests.forEach((controller) => controller.abort());
    closeDialog();
    disable({ refreshList: false });
    button?.remove();
    button = null;
    vm = null;
    metadata = [];
    mappedAppIds.clear();
    draft = createEmptyState();
    applied = createEmptyState();
  }

  return { cleanup, mount };
}
