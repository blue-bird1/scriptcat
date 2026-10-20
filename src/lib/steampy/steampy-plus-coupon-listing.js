const BUTTON_ID = "steamPyPlusCouponListingButton";
const DIALOG_ID = "steamPyPlusCouponListingDialog";
const FILTER_ANCHOR_SELECTOR = ".tag.flex-row.align-items-center";
const PAGE_COUNT_STORAGE_KEY = "steamPyPlusCouponListingPageCount";
const MAX_PAY_STORAGE_KEY = "steamPyPlusCouponListingMaxPay";
const COUPON_ID_STORAGE_KEY = "steamPyPlusCouponListingCouponId";
const MANUAL_DEDUCTION_STORAGE_KEY = "steamPyPlusCouponListingDeduction";
const MANUAL_MINIMUM_STORAGE_KEY = "steamPyPlusCouponListingMinimum";
const LISTING_PAGE_SIZE = 20;
const COUPON_PAGE_SIZE = 27;
const QUERY_CONCURRENCY = 2;
const REGIONS = new Set(["cn", "ru", "us", "tl"]);
const WEB_DEVICES = new Set([0, 3]);
const LOG_PREFIX = "[SteamPy Plus][CouponListing]";

function log(level, event, fields = {}) {
  const entry = { time: new Date().toISOString(), level, event, ...fields };
  const write = level === "error" ? console.error : console.info;
  write(LOG_PREFIX, entry);
}

export function parseCouponAmount(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function normalizeCouponRegion(value) {
  const region = String(value ?? "").trim().toLowerCase();
  return REGIONS.has(region) ? region : null;
}

function specificGameId(value) {
  if (value === null || value === undefined || value === "" || value === 0 || value === "0") return null;
  return String(value);
}

export function normalizeCdkCoupon(raw) {
  const promoType = raw?.promoType;
  if (promoType?.type !== "key") return null;
  const device = promoType.device === undefined || promoType.device === null ? 0 : Number(promoType.device);
  if (!WEB_DEVICES.has(device)) return null;
  const deduction = parseCouponAmount(raw.codePrice);
  const minimum = parseCouponAmount(promoType.txMini);
  return {
    id: raw.id === undefined || raw.id === null ? "" : String(raw.id),
    name: promoType.name || "未命名 CDK 券",
    area: String(promoType.area || "").trim().toLowerCase(),
    deduction,
    minimum,
    gameId: specificGameId(promoType.gameId),
    remark: promoType.remark || "",
  };
}

export function quoteInStockListing(row, minimum, deduction, maxPay) {
  const price = Number(row?.keyPrice);
  const stock = Number(row?.stock);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(stock)) return { kind: "invalid" };
  if (stock <= 0) return { kind: "out-of-stock", price };
  if (price < minimum) return { kind: "below-minimum", price };
  const payable = Math.max(0, price - deduction);
  if (maxPay !== null && payable > maxPay) return { kind: "over-max", price, payable };
  return { kind: "usable", price, payable, stock };
}

function formatPrice(value) {
  return Number.isFinite(value) ? `￥${value.toFixed(2)}` : "--";
}

function gameNameOf(game) {
  return game?.gameNameCn || game?.gameName || game?.name || "未命名游戏";
}

function readPage(response) {
  const page = Array.isArray(response?.content) ? response : response?.result;
  return {
    content: Array.isArray(page?.content) ? page.content : null,
    totalPages: Number(page?.totalPages),
    totalElements: Number(page?.totalElements),
  };
}

export function createSteamPyCouponListingController({
  client,
  shouldShow = null,
  getValue = GM_getValue,
  setValue = GM_setValue,
} = {}) {
  let vm = null;
  let button = null;
  let dialog = null;
  let couponSelect = null;
  let deductionInput = null;
  let minimumInput = null;
  let maxPayInput = null;
  let pageCountInput = null;
  let note = null;
  let progress = null;
  let startButton = null;
  let coupons = [];
  let generation = 0;
  let querying = false;

  function region() {
    return normalizeCouponRegion(vm?.areas);
  }

  function selectedCoupon() {
    const id = couponSelect?.value;
    if (!id) return null;
    return coupons.find((coupon) => coupon.id === id) || null;
  }

  function persistInputs() {
    setValue?.(PAGE_COUNT_STORAGE_KEY, pageCountInput?.value ?? "");
    setValue?.(MAX_PAY_STORAGE_KEY, maxPayInput?.value ?? "");
    setValue?.(COUPON_ID_STORAGE_KEY, couponSelect?.value ?? "");
    setValue?.(MANUAL_DEDUCTION_STORAGE_KEY, deductionInput?.value ?? "");
    setValue?.(MANUAL_MINIMUM_STORAGE_KEY, minimumInput?.value ?? "");
  }

  function applyCouponToInputs(coupon) {
    if (!deductionInput || !minimumInput) return;
    deductionInput.value = coupon?.deduction === null || coupon?.deduction === undefined ? "" : String(coupon.deduction);
    minimumInput.value = coupon?.minimum === null || coupon?.minimum === undefined ? "" : String(coupon.minimum);
    if (!note) return;
    if (!coupon) {
      note.textContent = "未选择券时手填抵扣额和交易额下限。交易额下限为 0 表示无门槛。";
      return;
    }
    const missing = [];
    if (coupon.deduction === null) missing.push("抵扣额");
    if (coupon.minimum === null) missing.push("交易额下限");
    note.textContent = missing.length
      ? `「${coupon.name}」没有返回${missing.join("、")}，需要手填。`
      : `已填入「${coupon.name}」。抵扣额 ${formatPrice(coupon.deduction)}，交易额下限 ${formatPrice(coupon.minimum)}。${coupon.gameId ? "仅适用于指定游戏。" : ""}${coupon.remark}`;
  }

  function restoreInputs() {
    if (pageCountInput) pageCountInput.value = String(getValue?.(PAGE_COUNT_STORAGE_KEY, "") ?? "");
    if (maxPayInput) maxPayInput.value = String(getValue?.(MAX_PAY_STORAGE_KEY, "") ?? "");
    if (deductionInput) deductionInput.value = String(getValue?.(MANUAL_DEDUCTION_STORAGE_KEY, "") ?? "");
    if (minimumInput) minimumInput.value = String(getValue?.(MANUAL_MINIMUM_STORAGE_KEY, "") ?? "");
    const savedId = String(getValue?.(COUPON_ID_STORAGE_KEY, "") ?? "");
    if (couponSelect && [...couponSelect.options].some((option) => option.value === savedId)) {
      couponSelect.value = savedId;
      applyCouponToInputs(selectedCoupon());
    }
  }

  function setProgress(text) {
    if (progress) progress.textContent = text;
  }

  function closeDialog() {
    generation += 1;
    querying = false;
    dialog?.remove();
    dialog = null;
    couponSelect = null;
    deductionInput = null;
    minimumInput = null;
    maxPayInput = null;
    pageCountInput = null;
    note = null;
    progress = null;
    startButton = null;
  }

  function field(labelText, control) {
    const label = document.createElement("label");
    label.style.cssText = "display:flex;flex-direction:column;gap:.04rem;font-size:.13rem;";
    const title = document.createElement("span");
    title.textContent = labelText;
    label.append(title, control);
    return label;
  }

  function numberInput(placeholder) {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "0.01";
    input.placeholder = placeholder;
    input.style.cssText = "height:.32rem;padding:0 .08rem;border:1px solid #dcdee2;border-radius:.04rem;font-size:.13rem;color:#17233d;box-sizing:border-box;";
    return input;
  }

  function renderCoupons() {
    if (!couponSelect) return;
    const current = couponSelect.value;
    couponSelect.replaceChildren();
    const manual = document.createElement("option");
    manual.value = "";
    manual.textContent = "手填";
    couponSelect.append(manual);
    coupons.forEach((coupon) => {
      const option = document.createElement("option");
      option.value = coupon.id;
      const amount = coupon.deduction === null ? "面额未知" : formatPrice(coupon.deduction);
      const floor = coupon.minimum === null ? "下限未知" : `满 ${formatPrice(coupon.minimum)}`;
      option.textContent = `${coupon.name} · ${amount} · ${floor}`;
      couponSelect.append(option);
    });
    if ([...couponSelect.options].some((option) => option.value === current)) couponSelect.value = current;
  }

  async function loadCoupons() {
    const currentRegion = region();
    if (!currentRegion) {
      note.textContent = "当前列表地区无法识别，只能手填。";
      log("error", "coupon_region_unsupported", { areas: vm?.areas ?? null });
      return;
    }
    if (!client?.fetchPromoCodeList) {
      note.textContent = "无法读取卡券中心，只能手填。";
      log("error", "coupon_client_missing", {});
      return;
    }
    try {
      const collected = [];
      const loadGeneration = generation;
      let pageNumber = 1;
      let totalElements = null;
      while (loadGeneration === generation) {
        const page = await client.fetchPromoCodeList({ pageNumber, pageSize: COUPON_PAGE_SIZE });
        const content = Array.isArray(page?.content) ? page.content : null;
        if (!content) throw new Error("卡券中心返回的数据格式无效");
        if (totalElements === null && Number.isFinite(Number(page.totalElements))) {
          totalElements = Number(page.totalElements);
        }
        collected.push(...content);
        log("info", "coupon_page_loaded", {
          pageNumber,
          count: content.length,
          totalElements,
        });
        if (!content.length || content.length < COUPON_PAGE_SIZE) break;
        if (totalElements !== null && collected.length >= totalElements) break;
        pageNumber += 1;
      }
      if (loadGeneration !== generation) return;
      const normalized = collected.map(normalizeCdkCoupon).filter(Boolean);
      const matched = normalized.filter((coupon) => coupon.area === currentRegion);
      coupons = matched;
      renderCoupons();
      restoreInputs();
      log("info", "coupon_list_loaded", {
        region: currentRegion,
        received: collected.length,
        cdk: normalized.length,
        matched: matched.length,
      });
      if (!note) return;
      if (!matched.length) {
        note.textContent = "卡券中心没有当前地区未使用的网页 CDK 券，可以手填。";
      } else if (!couponSelect?.value) {
        note.textContent = `已读取 ${matched.length} 张当前地区 CDK 券。`;
      }
    } catch (error) {
      coupons = [];
      renderCoupons();
      if (note) note.textContent = `卡券中心读取失败：${error?.message || error}。可以手填。`;
      log("error", "coupon_list_failed", { message: error?.message || String(error) });
    }
  }

  function appendRow(index, name, price, payable, status, href) {
    const tbody = dialog?.querySelector("tbody");
    const row = tbody?.children[index];
    if (!row) return;
    const nameCell = document.createElement("td");
    nameCell.style.cssText = "padding:.06rem .1rem;border:1px solid #e8eaec;";
    if (href) {
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = name;
      link.style.cssText = "color:#2d8cf0;text-decoration:none;";
      nameCell.append(link);
    } else {
      nameCell.textContent = name;
    }
    const cells = [nameCell];
    [formatPrice(price), formatPrice(payable), status].forEach((text, index) => {
      const cell = document.createElement("td");
      cell.textContent = text;
      cell.style.cssText = "padding:.06rem .1rem;border:1px solid #e8eaec;";
      if (index === 2 && status === "可用") cell.style.color = "#16a34a";
      cells.push(cell);
    });
    row.replaceChildren(...cells);
  }

  async function resolveGameId(game) {
    const direct = game?.id ?? game?.gameId;
    if (direct !== null && direct !== undefined && direct !== "") return String(direct);
    if (game?.appId === null || game?.appId === undefined || game?.appId === "") return null;
    const result = await client.fetchSteamGameByAppId(game.appId);
    const gameId = result?.content?.[0]?.id;
    return gameId === null || gameId === undefined || gameId === "" ? null : String(gameId);
  }

  async function loadGamePage(pageNumber, currentRegion) {
    if (typeof vm?.cdkListApi === "function") {
      return readPage(await vm.cdkListApi({ ...vm.searchForm, pageNumber }));
    }
    return readPage(await client.fetchSteamGameKeyHot({
      region: currentRegion,
      ...vm?.searchForm,
      pageNumber,
    }));
  }

  async function collectGames(pageCount, currentRegion, queryGeneration) {
    const startPage = Number(vm?.searchForm?.pageNumber) || 1;
    const games = [];
    let totalPages = null;
    for (let offset = 0; offset < pageCount; offset += 1) {
      if (queryGeneration !== generation) return null;
      const pageNumber = startPage + offset;
      if (totalPages !== null && pageNumber > totalPages) break;
      const page = await loadGamePage(pageNumber, currentRegion);
      if (!page.content) throw new Error(`第 ${pageNumber} 页游戏列表格式无效`);
      if (Number.isFinite(page.totalPages)) totalPages = page.totalPages;
      const visible = typeof shouldShow === "function" ? page.content.filter((game) => shouldShow(game)) : page.content;
      games.push(...visible);
      log("info", "game_page_loaded", {
        pageNumber,
        received: page.content.length,
        visible: visible.length,
        totalPages: Number.isFinite(page.totalPages) ? page.totalPages : null,
      });
      setProgress(`已读取游戏列表第 ${pageNumber} 页`);
      if (!page.content.length) break;
      if (totalPages !== null && pageNumber >= totalPages) break;
    }
    return games;
  }

  async function findListing(gameId, currentRegion, minimum, deduction, maxPay, queryGeneration) {
    let pageNumber = 1;
    let seen = 0;
    let totalElements = null;
    let lowestInStock = null;
    while (queryGeneration === generation) {
      const page = await client.fetchKeySaleList({
        region: currentRegion,
        gameId,
        pageNumber,
        pageSize: LISTING_PAGE_SIZE,
      });
      const content = Array.isArray(page?.content) ? page.content : null;
      if (!content) throw new Error("挂单列表格式无效");
      if (totalElements === null && Number.isFinite(Number(page?.totalElements))) {
        totalElements = Number(page.totalElements);
      }
      let invalid = 0;
      let outOfStock = 0;
      let belowMinimum = 0;
      for (const row of content) {
        seen += 1;
        const quote = quoteInStockListing(row, minimum, deduction, maxPay);
        if (quote.kind === "invalid") invalid += 1;
        else if (quote.kind === "out-of-stock") outOfStock += 1;
        else if (quote.kind === "below-minimum") {
          belowMinimum += 1;
          if (lowestInStock === null || quote.price < lowestInStock) lowestInStock = quote.price;
        } else if (quote.kind === "over-max") {
          if (lowestInStock === null || quote.price < lowestInStock) lowestInStock = quote.price;
          log("info", "listing_page_loaded", { gameId, pageNumber, count: content.length, invalid, outOfStock, belowMinimum, result: "over-max" });
          return { ok: false, price: quote.price, payable: quote.payable, status: "用券后自付超过上限" };
        } else {
          log("info", "listing_page_loaded", { gameId, pageNumber, count: content.length, invalid, outOfStock, belowMinimum, result: "usable", price: quote.price });
          return { ok: true, price: quote.price, payable: quote.payable, status: "可用" };
        }
      }
      log("info", "listing_page_loaded", { gameId, pageNumber, count: content.length, invalid, outOfStock, belowMinimum, result: "continue" });
      if (!content.length || content.length < LISTING_PAGE_SIZE) break;
      if (totalElements !== null && seen >= totalElements) break;
      pageNumber += 1;
    }
    return {
      ok: false,
      price: lowestInStock,
      payable: null,
      status: lowestInStock === null ? "无在售挂单" : "无达到交易额下限的挂单",
    };
  }

  async function runQuery() {
    if (querying) return;
    const deduction = parseCouponAmount(deductionInput?.value);
    const minimum = parseCouponAmount(minimumInput?.value);
    const maxPay = parseCouponAmount(maxPayInput?.value);
    const pageCount = Number(pageCountInput?.value);
    const currentRegion = region();
    if (!currentRegion) {
      setProgress("当前列表地区无法识别");
      return;
    }
    if (deduction === null || minimum === null) {
      setProgress("请填写抵扣额和交易额下限");
      return;
    }
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      setProgress("查询页数需要是大于等于 1 的整数");
      return;
    }
    if (maxPayInput?.value.trim() && maxPay === null) {
      setProgress("最高自付无效");
      return;
    }
    persistInputs();
    const queryGeneration = ++generation;
    querying = true;
    if (startButton) startButton.textContent = "停止";
    dialog.querySelector("tbody")?.replaceChildren();
    const coupon = selectedCoupon();
    log("info", "scan_started", {
      region: currentRegion,
      couponId: coupon?.id || null,
      deduction,
      minimum,
      maxPay,
      pageCount,
    });
    try {
      const games = await collectGames(pageCount, currentRegion, queryGeneration);
      if (queryGeneration !== generation || !games) return;
      const total = games.length;
      let done = 0;
      let usable = 0;
      let nextIndex = 0;
      const tbody = dialog?.querySelector("tbody");
      for (let index = 0; index < total; index += 1) tbody?.append(document.createElement("tr"));
      setProgress(`已处理 0/${total} · 可用 0`);
      if (!total) {
        setProgress("这些页没有符合当前筛选的游戏");
        return;
      }

      async function worker() {
        while (queryGeneration === generation) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= total) return;
          const game = games[index];
          let result = { price: null, payable: null, status: "查询失败", gameId: null };
          try {
            if (client?.isTokenInvalid?.()) {
              result = { price: null, payable: null, status: "AccessToken 已失效", gameId: null };
              setProgress("已停止：AccessToken 已失效，请重新登录后刷新页面");
              querying = false;
              if (startButton) startButton.textContent = "开始查询";
              generation += 1;
            } else {
              const gameId = await resolveGameId(game);
              if (queryGeneration !== generation) return;
              if (!gameId) result = { price: null, payable: null, status: "缺少 gameId", gameId: null };
              else if (coupon?.gameId && coupon.gameId !== gameId) result = { price: null, payable: null, status: "券不适用于此游戏", gameId };
              else result = { ...await findListing(gameId, currentRegion, minimum, deduction, maxPay, queryGeneration), gameId };
            }
          } catch (error) {
            result = { price: null, payable: null, status: error?.message || String(error), gameId: null };
            log("error", "game_query_failed", { message: error?.message || String(error) });
          }
          if (queryGeneration !== generation) return;
          done += 1;
          if (result.status === "可用") usable += 1;
          appendRow(
            index,
            gameNameOf(game),
            result.price,
            result.payable,
            result.status,
            result.gameId ? `https://steampy.com/cdkDetail?name=${currentRegion}&gameId=${result.gameId}` : "",
          );
          setProgress(`已处理 ${done}/${total} · 可用 ${usable}`);
          log("info", "game_checked", { index, status: result.status, price: result.price ?? null });
        }
      }

      await Promise.all(Array.from({ length: QUERY_CONCURRENCY }, () => worker()));
      if (queryGeneration !== generation) return;
      setProgress(`查询结束 · 已处理 ${total}/${total} · 可用 ${usable}`);
      log("info", "scan_finished", { total, usable });
    } catch (error) {
      if (queryGeneration !== generation) return;
      setProgress(error?.message || String(error));
      log("error", "scan_failed", { message: error?.message || String(error) });
    } finally {
      if (queryGeneration === generation) {
        querying = false;
        if (startButton) startButton.textContent = "开始查询";
      }
    }
  }

  function toggleQuery() {
    if (querying) {
      generation += 1;
      querying = false;
      if (startButton) startButton.textContent = "开始查询";
      setProgress("已停止");
      log("info", "scan_cancelled", {});
      return;
    }
    runQuery();
  }

  function openDialog() {
    if (dialog) return;
    const overlay = document.createElement("div");
    overlay.id = DIALOG_ID;
    overlay.style.cssText = "position:fixed;z-index:10000;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.38);";
    const panel = document.createElement("section");
    panel.style.cssText = "width:min(8.4rem,94vw);height:min(78vh,9rem);display:flex;flex-direction:column;gap:.12rem;padding:.2rem;border-radius:.08rem;background:#fff;color:#17233d;box-sizing:border-box;";
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;";
    const title = document.createElement("h3");
    title.textContent = "按券查挂单";
    title.style.cssText = "margin:0;font-size:.18rem;";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ivu-btn ivu-btn-default ivu-btn-sm";
    close.textContent = "关闭";
    close.addEventListener("click", closeDialog);
    header.append(title, close);

    couponSelect = document.createElement("select");
    couponSelect.style.cssText = "height:.32rem;border:1px solid #dcdee2;border-radius:.04rem;font-size:.13rem;color:#17233d;";
    couponSelect.addEventListener("change", () => {
      const coupon = selectedCoupon();
      if (coupon) applyCouponToInputs(coupon);
      else if (note) note.textContent = "未选择券时手填抵扣额和交易额下限。交易额下限为 0 表示无门槛。";
    });
    deductionInput = numberInput("券抵扣额");
    minimumInput = numberInput("0 表示无门槛");
    maxPayInput = numberInput("可空");
    pageCountInput = numberInput("从当前页起");
    pageCountInput.min = "1";
    pageCountInput.step = "1";
    const form = document.createElement("div");
    form.style.cssText = "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.1rem;";
    form.append(
      field("CDK 券", couponSelect),
      field("抵扣额", deductionInput),
      field("交易额下限", minimumInput),
      field("最高自付", maxPayInput),
      field("查询页数", pageCountInput),
    );
    note = document.createElement("div");
    note.style.cssText = "font-size:.12rem;color:#666;";
    progress = document.createElement("div");
    progress.style.cssText = "font-size:.13rem;color:#17233d;";
    progress.textContent = "尚未查询";
    startButton = document.createElement("button");
    startButton.type = "button";
    startButton.className = "ivu-btn ivu-btn-primary ivu-btn-sm";
    startButton.textContent = "开始查询";
    startButton.addEventListener("click", toggleQuery);
    const tableWrap = document.createElement("div");
    tableWrap.style.cssText = "flex:1;min-height:0;overflow:auto;";
    const table = document.createElement("table");
    table.style.cssText = "width:100%;border-collapse:collapse;font-size:.13rem;";
    const head = document.createElement("tr");
    ["游戏", "挂单价", "用券后自付", "状态"].forEach((text) => {
      const cell = document.createElement("th");
      cell.textContent = text;
      cell.style.cssText = "padding:.08rem .1rem;border:1px solid #e8eaec;text-align:left;background:#f5f7fa;";
      head.append(cell);
    });
    const thead = document.createElement("thead");
    thead.append(head);
    table.append(thead, document.createElement("tbody"));
    tableWrap.append(table);
    panel.append(header, form, note, progress, startButton, tableWrap);
    overlay.append(panel);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeDialog();
    });
    document.body.append(overlay);
    dialog = overlay;
    renderCoupons();
    restoreInputs();
    loadCoupons();
  }

  function mount() {
    if (button?.isConnected) return true;
    const anchor = document.querySelector(FILTER_ANCHOR_SELECTOR);
    if (!anchor) return false;
    document.getElementById(BUTTON_ID)?.remove();
    button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.className = "ivu-btn ivu-btn-default ivu-btn-sm";
    button.textContent = "按券查挂单";
    button.style.cssText = "margin-left:.08rem;";
    button.addEventListener("click", openDialog);
    anchor.append(button);
    return true;
  }

  function start(nextVm) {
    if (vm && vm !== nextVm) cleanup();
    vm = nextVm;
    if (!vm) return;
    mount();
  }

  function cleanup() {
    generation += 1;
    querying = false;
    closeDialog();
    button?.remove();
    button = null;
    vm = null;
    coupons = [];
  }

  return { cleanup, mount, start };
}
