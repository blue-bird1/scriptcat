function sameList(first, second) {
  return first.length === second.length && first.every((item, index) => item === second[index]);
}

function listSignature(list, vm) {
  const form = vm.searchForm || {};
  const formPart = [
    form.pageNumber,
    form.pageSize,
    form.sort,
    form.order,
    form.startDate,
    form.endDate,
    form.gameName || form.keywords || form.name || "",
  ].join("|");
  return `${formPart}::${list.map((game) => game?.id || game?.gameId || game?.appId || game?.gameName || "").join(",")}`;
}

function captureSourceList(vm) {
  if (!Array.isArray(vm?.gameList) || vm.__steamPyPlusApplyingFilter) return;
  if (vm.gameList === vm.__steamPyPlusLastFilteredList) return;
  const signature = listSignature(vm.gameList, vm);
  if (signature === vm.__steamPyPlusLastFilteredSignature) return;
  vm.__steamPyPlusOriginalGameList = vm.gameList.slice();
  vm.__steamPyPlusOriginalSignature = signature;
}

function applySavedFilter(vm, shouldShow) {
  if (!Array.isArray(vm?.gameList)) return false;
  captureSourceList(vm);
  const source = vm.__steamPyPlusOriginalGameList || vm.gameList.slice();
  const nextList = source.filter(shouldShow);
  if (sameList(nextList, vm.gameList)) return false;

  vm.__steamPyPlusApplyingFilter = true;
  vm.gameList = nextList;
  vm.__steamPyPlusLastFilteredList = nextList;
  vm.__steamPyPlusLastFilteredSignature = listSignature(nextList, vm);
  vm.$nextTick?.(() => {
    vm.__steamPyPlusApplyingFilter = false;
  });
  return true;
}

function addUpdatedHook(element, callback) {
  const options = element?.__vue__?.$options;
  if (!options) return false;
  if (!options.updated) options.updated = [];
  else if (!Array.isArray(options.updated)) options.updated = [options.updated];
  options.updated.push(function updatedHook(...args) {
    callback.apply(this, args);
  });
  return true;
}

function walkVue3Components(component, visitor, seen = new Set()) {
  if (!component || seen.has(component)) return null;
  seen.add(component);
  const matched = visitor(component);
  return matched || walkVue3VNode(component.subTree, visitor, seen);
}

function walkVue3VNode(vnode, visitor, seen) {
  if (!vnode) return null;
  if (vnode.component) {
    const matched = walkVue3Components(vnode.component, visitor, seen);
    if (matched) return matched;
  }
  const children = vnode.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const matched = walkVue3VNode(child, visitor, seen);
      if (matched) return matched;
    }
  } else if (children && typeof children === "object") {
    for (const child of Object.values(children)) {
      const values = Array.isArray(child) ? child : [child];
      for (const value of values) {
        const matched = walkVue3VNode(value, visitor, seen);
        if (matched) return matched;
      }
    }
  }
  return null;
}

function hasGameBlock(component) {
  const element = component?.subTree?.el || component?.vnode?.el;
  return Boolean(element?.querySelector?.(".gameblock") || element?.matches?.(".gameblock"));
}

function findVue3BuyerVm({ silent = false } = {}) {
  const root = document.querySelector("#app")?._vnode?.component;
  if (!root) {
    if (!silent) console.warn("[SteamPy Plus] 未找到 Vue3 根组件");
    return null;
  }
  const match = walkVue3Components(root, (component) => {
    const proxy = component.proxy;
    if (!Array.isArray(proxy?.gameList) || typeof proxy.getGameList !== "function" || typeof proxy.goToChoose !== "function") return null;
    if (!hasGameBlock(component) && typeof proxy.total !== "number") return null;
    return proxy;
  });
  if (!match && !silent) console.warn("[SteamPy Plus] 未找到新版 CDKey 买家 Vue 实例");
  return match;
}

export function createSteamPyBuyerController({ elmGetter, jQuery, filter, rating }) {
  let legacyVm = null;
  let proVm = null;
  let legacyStarted = false;
  let proStarted = false;

  function processCards(vm) {
    rating.processCards(document.querySelectorAll(".gameblock"), vm?.gameList, vm?.__steamPyPlusOriginalGameList);
  }

  function applyLegacy() {
    if (!legacyVm) legacyVm = jQuery(".game_layout .game_layout").get(0)?.__vue__ || null;
    if (!legacyVm) return;
    applySavedFilter(legacyVm, filter.shouldShow);
    legacyVm.$nextTick?.(() => processCards(legacyVm));
  }

  function applyPro() {
    if (!proVm) proVm = findVue3BuyerVm({ silent: true });
    if (!proVm) return;
    applySavedFilter(proVm, filter.shouldShow);
    proVm.$nextTick?.(() => processCards(proVm));
  }

  async function startLegacy() {
    if (legacyStarted) return;
    await elmGetter.get("div.ivu-tabs-content div.flex-row.jc-space-flex-start.flex-wrap.w-auto");
    legacyVm = jQuery(".game_layout .game_layout").get(0)?.__vue__ || null;
    const tabPane = jQuery(".ivu-tabs-tabpane").get(0);
    addUpdatedHook(tabPane, () => applyLegacy());
    setTimeout(() => applyLegacy(), 600);
    legacyStarted = true;
  }

  async function waitForProVm() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const vm = findVue3BuyerVm({ silent: true });
      if (vm) return vm;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }

  function installProWatcher(vm) {
    if (vm.__steamPyPlusWatcherInstalled || typeof vm.$watch !== "function") return;
    vm.__steamPyPlusWatcherInstalled = true;
    vm.__steamPyPlusUnwatch = vm.$watch("gameList", () => {
      captureSourceList(vm);
      applyPro();
      vm.$nextTick?.(() => processCards(vm));
    }, { deep: false });
  }

  async function startPro() {
    if (proStarted) return;
    await elmGetter.get(".tag.flex-row.align-items-center");
    await elmGetter.get(".gameblock");
    proVm = await waitForProVm();
    if (!proVm) {
      console.warn("[SteamPy Plus] 新版 CDKey 买家页初始化失败：未找到 Vue3 买家实例");
      return;
    }
    captureSourceList(proVm);
    installProWatcher(proVm);
    applyPro();
    proStarted = true;
  }

  function applyCurrent(pathname) {
    if (pathname.startsWith("/pro/cdKey/cdKey")) applyPro();
    else if (pathname.startsWith("/cdKey/cdKey")) applyLegacy();
  }

  function cleanupLegacy() {
    legacyVm = null;
    legacyStarted = false;
  }

  function cleanupPro() {
    if (proVm?.__steamPyPlusUnwatch) proVm.__steamPyPlusUnwatch();
    if (proVm) proVm.__steamPyPlusWatcherInstalled = false;
    proVm = null;
    proStarted = false;
  }

  return { applyCurrent, cleanupLegacy, cleanupPro, startLegacy, startPro };
}
