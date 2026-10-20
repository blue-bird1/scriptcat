const BUTTON_ID = "steamPyPlusCouponListingButton";
const DIALOG_ID = "steamPyPlusCouponListingDialog";
const FILTER_ANCHOR_SELECTOR = ".tag.flex-row.align-items-center";
const PAGE_COUNT_STORAGE_KEY = "steamPyPlusCouponListingPageCount";
const MAX_PAY_STORAGE_KEY = "steamPyPlusCouponListingMaxPay";
const COUPON_ID_STORAGE_KEY = "steamPyPlusCouponListingCouponId";
const ENABLED_STORAGE_KEY = "steamPyPlusCouponListingEnabled";
const MENU_ID = "steam-py-plus-coupon-listing";
const MANUAL_DEDUCTION_STORAGE_KEY = "steamPyPlusCouponListingDeduction";
const MANUAL_MINIMUM_STORAGE_KEY = "steamPyPlusCouponListingMinimum";
const LISTING_PAGE_SIZE = 20;
const COUPON_PAGE_SIZE = 27;
const QUERY_CONCURRENCY = 2;
const REGIONS = new Set(["cn", "ru", "us", "tl"]);
const WEB_DEVICES = new Set([0, 3]);
const LOG_PREFIX = "[SteamPy Plus][CouponListing]";
const STATUS_USABLE = "可用";
const STATUS_OVER_MAX = "实付超过上限";
const STATUS_NO_LISTING = "无库存";
const STATUS_BELOW_MIN = "未达使用门槛";
const STATUS_WRONG_GAME = "不适用于此游戏";
const STATUS_NO_GAME = "无法识别商品";
const STATUS_TOKEN = "登录已失效";
const MANUAL_NOTE = "未选择优惠券时，填写面额和使用门槛。使用门槛为 0 表示无使用门槛。";

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

function appIdOf(game) {
  const parsed = Number(game?.appId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function createSteamPyCouponListingController({
  client,
  shouldShow = null,
  isGameOwned = null,
  getValue = GM_getValue,
  setValue = GM_setValue,
  registerMenuCommand = GM_registerMenuCommand,
} = {}) {
  let enabled = getValue(ENABLED_STORAGE_KEY, false) === true;
  let menusRegistered = false;
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
    note.textContent = describeCoupon(coupon);
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

  function describeCoupon(coupon) {
    if (!coupon) return MANUAL_NOTE;
    const parts = [`「${coupon.name}」`];
    parts.push(coupon.deduction === null ? "面额缺失" : `面额 ${formatPrice(coupon.deduction)}`);
    if (coupon.minimum === null) parts.push("使用门槛缺失");
    else if (coupon.minimum === 0) parts.push("无使用门槛");
    else parts.push(`使用门槛 ${formatPrice(coupon.minimum)}`);
    if (coupon.gameId) parts.push("仅限指定游戏");
    return `${parts.join("，")}。`;
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
    manual.textContent = "手动填写";
    couponSelect.append(manual);
    coupons.forEach((coupon) => {
      const option = document.createElement("option");
      option.value = coupon.id;
      const amount = coupon.deduction === null ? "面额缺失" : `面额 ${formatPrice(coupon.deduction)}`;
      const floor = coupon.minimum === null
        ? "使用门槛缺失"
        : coupon.minimum === 0
          ? "无使用门槛"
          : `使用门槛 ${formatPrice(coupon.minimum)}`;
      option.textContent = `${coupon.name}，${amount}，${floor}`;
      couponSelect.append(option);
    });
    if ([...couponSelect.options].some((option) => option.value === current)) couponSelect.value = current;
  }

  async function loadCoupons() {
    const currentRegion = region();
    if (!currentRegion) {
      note.textContent = "无法识别当前地区，请手动填写。";
      log("error", "coupon_region_unsupported", { areas: vm?.areas ?? null });
      return;
    }
    if (!client?.fetchPromoCodeList) {
      note.textContent = "无法读取优惠券，请手动填写。";
      log("error", "coupon_client_missing", {});
      return;
    }
    const loadGeneration = generation;
    try {
      const collected = [];
      let pageNumber = 1;
      let totalElements = null;
      while (loadGeneration === generation) {
        const page = await client.fetchPromoCodeList({ pageNumber, pageSize: COUPON_PAGE_SIZE });
        if (loadGeneration !== generation) return;
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
        note.textContent = "当前地区没有未使用的 CDK 优惠券，请手动填写。";
      } else if (!couponSelect?.value) {
        note.textContent = `已读取 ${matched.length} 张未使用的 CDK 优惠券。`;
      }
    } catch (error) {
      log("error", "coupon_list_failed", { message: error?.message || String(error) });
      if (loadGeneration !== generation) return;
      coupons = [];
      renderCoupons();
      if (note) note.textContent = `优惠券读取失败：${error?.message || error}。请手动填写。`;
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
      if (index === 2 && status === STATUS_USABLE) cell.style.color = "#16a34a";
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
    let ownedSkipped = 0;
    let totalPages = null;
    for (let offset = 0; offset < pageCount; offset += 1) {
      if (queryGeneration !== generation) return null;
      const pageNumber = startPage + offset;
      if (totalPages !== null && pageNumber > totalPages) break;
      const page = await loadGamePage(pageNumber, currentRegion);
      if (queryGeneration !== generation) return null;
      if (!page.content) throw new Error(`第 ${pageNumber} 页游戏列表格式无效`);
      if (Number.isFinite(page.totalPages)) totalPages = page.totalPages;
      const unowned = page.content.filter((game) => {
        const appId = appIdOf(game);
        return appId === null || !isGameOwned?.(appId);
      });
      const pageOwnedSkipped = page.content.length - unowned.length;
      ownedSkipped += pageOwnedSkipped;
      const visible = typeof shouldShow === "function" ? unowned.filter((game) => shouldShow(game)) : unowned;
      games.push(...visible);
      log("info", "game_page_loaded", {
        pageNumber,
        received: page.content.length,
        ownedSkipped: pageOwnedSkipped,
        visible: visible.length,
        totalPages: Number.isFinite(page.totalPages) ? page.totalPages : null,
      });
      setProgress(`正在读取第 ${pageNumber} 页`);
      if (!page.content.length) break;
      if (totalPages !== null && pageNumber >= totalPages) break;
    }
    return { games, ownedSkipped };
  }

  function progressText(done, total, usable, ownedSkipped) {
    const owned = ownedSkipped > 0 ? `，已跳过已拥有 ${ownedSkipped}` : "";
    return `已处理 ${done}/${total}，可用 ${usable}${owned}`;
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
      if (queryGeneration !== generation) return null;
      const content = Array.isArray(page?.content) ? page.content : null;
      if (!content) throw new Error("列表数据无效");
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
          return { ok: false, price: quote.price, payable: quote.payable, status: STATUS_OVER_MAX };
        } else {
          log("info", "listing_page_loaded", { gameId, pageNumber, count: content.length, invalid, outOfStock, belowMinimum, result: "usable", price: quote.price });
          return { ok: true, price: quote.price, payable: quote.payable, status: STATUS_USABLE };
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
      status: lowestInStock === null ? STATUS_NO_LISTING : STATUS_BELOW_MIN,
    };
  }

  async function runQuery() {
    if (!enabled || !vm || !dialog || querying) return;
    const deduction = parseCouponAmount(deductionInput?.value);
    const minimum = parseCouponAmount(minimumInput?.value);
    const maxPay = parseCouponAmount(maxPayInput?.value);
    const pageCount = Number(pageCountInput?.value);
    const currentRegion = region();
    if (!currentRegion) {
      setProgress("无法识别当前地区");
      return;
    }
    if (deduction === null || minimum === null) {
      setProgress("请填写面额和使用门槛");
      return;
    }
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      setProgress("页数须为大于等于 1 的整数");
      return;
    }
    if (maxPayInput?.value.trim() && maxPay === null) {
      setProgress("实付上限无效");
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
      const collected = await collectGames(pageCount, currentRegion, queryGeneration);
      if (queryGeneration !== generation || !collected) return;
      const games = collected.games;
      const ownedSkipped = collected.ownedSkipped;
      const total = games.length;
      let done = 0;
      let usable = 0;
      let nextIndex = 0;
      const tbody = dialog?.querySelector("tbody");
      for (let index = 0; index < total; index += 1) tbody?.append(document.createElement("tr"));
      setProgress(progressText(0, total, 0, ownedSkipped));
      if (!total) {
        setProgress(ownedSkipped > 0 ? `没有待查询游戏，已跳过已拥有 ${ownedSkipped}` : "当前筛选下没有游戏");
        return;
      }

      const worker = async () => {
        while (queryGeneration === generation) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= total) return;
          const game = games[index];
          let result = { price: null, payable: null, status: "查询失败", gameId: null };
          try {
            if (client?.isTokenInvalid?.()) {
              result = { price: null, payable: null, status: STATUS_TOKEN, gameId: null };
              setProgress("登录已失效，请重新登录后刷新页面");
              querying = false;
              if (startButton) startButton.textContent = "查询";
              generation += 1;
            } else {
              const gameId = await resolveGameId(game);
              if (queryGeneration !== generation) return;
              if (!gameId) result = { price: null, payable: null, status: STATUS_NO_GAME, gameId: null };
              else if (coupon?.gameId && coupon.gameId !== gameId) result = { price: null, payable: null, status: STATUS_WRONG_GAME, gameId };
              else result = { ...await findListing(gameId, currentRegion, minimum, deduction, maxPay, queryGeneration), gameId };
            }
          } catch (error) {
            result = { price: null, payable: null, status: error?.message || String(error), gameId: null };
            log("error", "game_query_failed", { message: error?.message || String(error) });
          }
          if (queryGeneration !== generation) return;
          done += 1;
          if (result.status === STATUS_USABLE) usable += 1;
          appendRow(
            index,
            gameNameOf(game),
            result.price,
            result.payable,
            result.status,
            result.gameId ? `https://steampy.com/cdkDetail?name=${currentRegion}&gameId=${result.gameId}` : "",
          );
          setProgress(progressText(done, total, usable, ownedSkipped));
          log("info", "game_checked", { index, status: result.status, price: result.price ?? null });
        }
      };

      await Promise.all(Array.from({ length: QUERY_CONCURRENCY }, () => worker()));
      if (queryGeneration !== generation) return;
      setProgress(progressText(total, total, usable, ownedSkipped));
      log("info", "scan_finished", { total, usable });
    } catch (error) {
      if (queryGeneration !== generation) return;
      setProgress(error?.message || String(error));
      log("error", "scan_failed", { message: error?.message || String(error) });
    } finally {
      if (queryGeneration === generation) {
        querying = false;
        if (startButton) startButton.textContent = "查询";
      }
    }
  }

  function toggleQuery() {
    if (querying) {
      generation += 1;
      querying = false;
      if (startButton) startButton.textContent = "查询";
      setProgress("已停止");
      log("info", "scan_cancelled", {});
      return;
    }
    runQuery();
  }

  function openDialog() {
    if (!enabled || !vm || dialog) return;
    const overlay = document.createElement("div");
    overlay.id = DIALOG_ID;
    overlay.style.cssText = "position:fixed;z-index:10000;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.38);";
    const panel = document.createElement("section");
    panel.style.cssText = "width:min(8.4rem,94vw);height:min(78vh,9rem);display:flex;flex-direction:column;gap:.12rem;padding:.2rem;border-radius:.08rem;background:#fff;color:#17233d;box-sizing:border-box;";
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;";
    const title = document.createElement("h3");
    title.textContent = "优惠券查询";
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
      else if (note) note.textContent = MANUAL_NOTE;
    });
    deductionInput = numberInput("");
    minimumInput = numberInput("0");
    maxPayInput = numberInput("不限制");
    pageCountInput = numberInput("1");
    pageCountInput.min = "1";
    pageCountInput.step = "1";
    const form = document.createElement("div");
    form.style.cssText = "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.1rem;";
    const intro = document.createElement("p");
    intro.textContent = "查找有货、达到使用门槛且实付不超过上限的游戏。";
    intro.style.cssText = "margin:0;font-size:.13rem;color:#515a6e;";
    form.append(
      field("优惠券", couponSelect),
      field("面额", deductionInput),
      field("使用门槛", minimumInput),
      field("实付上限", maxPayInput),
      field("页数", pageCountInput),
    );
    note = document.createElement("div");
    note.style.cssText = "font-size:.12rem;color:#666;";
    progress = document.createElement("div");
    progress.style.cssText = "font-size:.13rem;color:#17233d;";
    progress.textContent = "未开始";
    startButton = document.createElement("button");
    startButton.type = "button";
    startButton.className = "ivu-btn ivu-btn-primary ivu-btn-sm";
    startButton.textContent = "查询";
    startButton.addEventListener("click", toggleQuery);
    const tableWrap = document.createElement("div");
    tableWrap.style.cssText = "flex:1;min-height:0;overflow:auto;";
    const table = document.createElement("table");
    table.style.cssText = "width:100%;border-collapse:collapse;font-size:.13rem;";
    const head = document.createElement("tr");
    ["游戏", "价格", "实付", "结果"].forEach((text) => {
      const cell = document.createElement("th");
      cell.textContent = text;
      cell.style.cssText = "padding:.08rem .1rem;border:1px solid #e8eaec;text-align:left;background:#f5f7fa;";
      head.append(cell);
    });
    const thead = document.createElement("thead");
    thead.append(head);
    table.append(thead, document.createElement("tbody"));
    tableWrap.append(table);
    panel.append(header, intro, form, note, progress, startButton, tableWrap);
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
    if (!enabled || !vm) return false;
    if (button?.isConnected) return true;
    const anchor = document.querySelector(FILTER_ANCHOR_SELECTOR);
    if (!anchor) return false;
    document.getElementById(BUTTON_ID)?.remove();
    button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.className = "ivu-btn ivu-btn-default ivu-btn-sm";
    button.textContent = "优惠券查询";
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

  function unmount() {
    closeDialog();
    button?.remove();
    button = null;
  }

  function cleanup() {
    unmount();
    vm = null;
    coupons = [];
  }

  function registerMenu() {
    const stateLabel = enabled ? "已开启（点击关闭）" : "已关闭（点击开启）";
    registerMenuCommand(`优惠券查询：${stateLabel}`, toggleEnabled, { id: MENU_ID });
  }

  function toggleEnabled() {
    enabled = !enabled;
    setValue(ENABLED_STORAGE_KEY, enabled);
    if (enabled) mount();
    else unmount();
    registerMenu();
    log("info", "coupon_listing_toggled", { enabled });
  }

  function registerMenus() {
    if (menusRegistered) return;
    menusRegistered = true;
    registerMenu();
  }

  return { cleanup, mount, registerMenus, start };
}
