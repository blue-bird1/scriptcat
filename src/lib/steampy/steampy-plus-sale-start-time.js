const PRO_DETAIL_PATH = "/pro/cdKey/cdkDetail";
const SALE_START_TIME_COLUMN_KEY = "steamPyPlusSaleStartedAt";
const STEAMPY_SNOWFLAKE_EPOCH_MS = 1_524_291_141_000n;
const CHINA_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  timeZone: "Asia/Shanghai",
  year: "numeric",
});

export const SALE_START_TIME_FALLBACK = "暂无";

export function decodeK900SaleStartedAt(saleId) {
  if (!/^K900\d+$/.test(String(saleId ?? ""))) return null;
  const milliseconds = (BigInt(String(saleId).slice(4)) >> 22n) + STEAMPY_SNOWFLAKE_EPOCH_MS;
  if (milliseconds < 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const value = Number(milliseconds);
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

export function formatK900SaleStartedAt(saleId) {
  const milliseconds = decodeK900SaleStartedAt(saleId);
  if (milliseconds === null) return SALE_START_TIME_FALLBACK;
  const parts = Object.fromEntries(
    CHINA_TIME_FORMATTER.formatToParts(new Date(milliseconds))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function walkVue3Component(component, visitor, seen = new Set()) {
  if (!component || seen.has(component)) return null;
  seen.add(component);
  return visitor(component) || walkVue3VNode(component.subTree, visitor, seen);
}

function walkVue3VNode(vnode, visitor, seen) {
  if (!vnode) return null;
  if (vnode.component) {
    const matched = walkVue3Component(vnode.component, visitor, seen);
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

function findDetailVm() {
  const root = document.querySelector("#app")?._vnode?.component;
  if (!root) return null;
  return walkVue3Component(root, (component) => {
    const proxy = component.proxy;
    if (proxy?.$options?.name !== "cdkDetail") return null;
    if (!Array.isArray(proxy.columns) || !Array.isArray(proxy.data)) return null;
    if (typeof proxy.getDataList !== "function" || typeof proxy.handleRowClick !== "function") return null;
    return proxy;
  });
}

function installColumn(vm) {
  if (vm.columns.some((column) => column?.key === SALE_START_TIME_COLUMN_KEY)) return;
  const inventoryIndex = vm.columns.findIndex((column) => column?.title === "库存");
  const insertIndex = inventoryIndex < 0 ? vm.columns.length : inventoryIndex + 1;
  vm.columns.splice(insertIndex, 0, {
    align: "center",
    key: SALE_START_TIME_COLUMN_KEY,
    minWidth: 170,
    sortable: false,
    title: "开始销售时间",
    render: (createElement, { row }) => createElement("span", formatK900SaleStartedAt(row?.saleId)),
  });
}

function removeColumn(vm) {
  const index = vm?.columns?.findIndex((column) => column?.key === SALE_START_TIME_COLUMN_KEY) ?? -1;
  if (index >= 0) vm.columns.splice(index, 1);
}

export function createSteamPySaleStartTimeController({
  pollIntervalMs = 250,
  maxAttempts = 60,
} = {}) {
  let active = false;
  let generation = 0;
  let detailVm = null;

  async function start() {
    if (active) return;
    active = true;
    const currentGeneration = ++generation;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (!active || currentGeneration !== generation || location.pathname !== PRO_DETAIL_PATH) return;
      detailVm = findDetailVm();
      if (detailVm) {
        installColumn(detailVm);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    console.warn("[SteamPy Plus] 新版 CDKey 详情页初始化失败：未找到销售列表 Vue 实例");
  }

  function cleanup() {
    active = false;
    generation += 1;
    removeColumn(detailVm);
    detailVm = null;
  }

  return { cleanup, start };
}
