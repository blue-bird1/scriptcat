// ==UserScript==
// @name         Digiphile Steam Key Helper
// @namespace    https://github.com/blue-bird1/scriptcat
// @version      1.1.0
// @description  批量读取、复制和激活 Digiphile Steam Key
// @author       blue-bird1
// @match        https://www.digiphile.co/customer/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      api.digiphile.co
// @connect      store.steampowered.com
// @run-at       document-idle
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/blue-bird1/scriptcat/main/digiphile-steam-keys.user.js
// @updateURL    https://raw.githubusercontent.com/blue-bird1/scriptcat/main/digiphile-steam-keys.user.js
// ==/UserScript==

(() => {
  // src/lib/userscript/gm-xhr.js
  function createGmXhrError(message, response) {
    const error = new Error(message);
    error.response = response;
    return error;
  }
  function gmXhr(options, sendRequest = GM_xmlhttpRequest) {
    return new Promise((resolve, reject) => {
      sendRequest({
        timeout: 2e4,
        ...options,
        onload: resolve,
        onerror: (response) => reject(createGmXhrError("网络请求失败", response)),
        ontimeout: (response) => reject(createGmXhrError("网络请求超时", response))
      });
    });
  }

  // src/lib/digiphile/log.js
  function log(level, event, runId, details = {}) {
    console[level](JSON.stringify({
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      event,
      runId,
      ...details
    }));
  }
  function logError(event, runId, error, details = {}) {
    log("error", event, runId, {
      ...details,
      message: error.message,
      stack: error.stack,
      requestId: error.requestId,
      status: error.status,
      response: error.response
    });
  }

  // src/lib/digiphile/api.js
  var API = "https://api.digiphile.co/api";
  var LAST_USER_KEY = "CognitoIdentityServiceProvider.1bktpqspo483aka9veb90j9800.LastAuthUser";
  function readToken() {
    const username = localStorage.getItem(LAST_USER_KEY);
    const prefix = LAST_USER_KEY.slice(0, -"LastAuthUser".length);
    const token = username && localStorage.getItem(`${prefix}${username}.idToken`);
    if (!token) throw new Error("登录凭据缺失，请登录 Digiphile。");
    return token;
  }
  function apiMessage(body) {
    if (Array.isArray(body?.errors) && body.errors.every((value) => typeof value === "string")) {
      return body.errors.join("；");
    }
    return typeof body?.message === "string" ? body.message : "";
  }
  async function request(method, path, runId, validate) {
    const requestId = crypto.randomUUID();
    const token = readToken();
    log("debug", "digiphile.request_started", runId, { requestId, method, path });
    let response;
    try {
      response = await gmXhr({
        method,
        url: `${API}${path}`,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        anonymous: true
      });
      const raw = response.responseText;
      let body;
      try {
        body = JSON.parse(raw);
      } catch (cause) {
        throw new Error(`Digiphile 返回非 JSON 响应（HTTP ${response.status}）。`, { cause });
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Digiphile 请求失败（HTTP ${response.status}）${apiMessage(body) ? `：${apiMessage(body)}` : "。"}`);
      }
      validate(body);
      log("debug", "digiphile.request_completed", runId, { requestId, status: response.status, response: raw });
      return body;
    } catch (error) {
      error.requestId = requestId;
      error.status = response?.status ?? error.response?.status;
      error.response = response?.responseText ?? error.response;
      throw error;
    }
  }
  function listSteamKeys(runId) {
    return request("GET", "/customer/steam-keys", runId, (body) => {
      if (!Array.isArray(body)) throw new Error("Digiphile Key 列表格式不正确。");
      const ids = /* @__PURE__ */ new Set();
      for (const item of body) {
        if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id) || typeof item.title !== "string" || typeof item.status !== "string" || typeof item.isGift !== "boolean" || item.expiresAt != null && (typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt)))) {
          throw new Error("Digiphile Key 条目缺少必要字段或格式不正确。");
        }
        ids.add(item.id);
      }
    });
  }
  async function readSteamKey(item, runId) {
    const info = availability(item);
    if (!info.available) throw new Error(`“${item.title}”${info.label}，请刷新列表。`);
    const action = item.status === "Revealed" ? "view" : "reveal";
    const body = await request("POST", `/customer/steam-keys/${encodeURIComponent(item.id)}/${action}`, runId, (value) => {
      if (typeof value?.steamKeyValue !== "string" || !value.steamKeyValue.trim()) {
        throw new Error("Digiphile 响应缺少有效 Key，请刷新列表后重试。");
      }
    });
    return { ...item, status: "Revealed", steamKeyValue: body.steamKeyValue };
  }
  function isExpired(item, now = Date.now()) {
    return Boolean(item.expiresAt) && Date.parse(item.expiresAt) <= now;
  }
  function availability(item, now = Date.now()) {
    if (isExpired(item, now)) {
      return { available: false, fresh: false, label: "已过期" };
    }
    if (item.isGift) return { available: false, fresh: false, label: "礼物，请在站点处理" };
    if (item.status === "Revealed") return { available: true, fresh: false, label: "已刮开" };
    if (item.status === "Assigned") return { available: true, fresh: true, label: "未刮开" };
    return { available: false, fresh: false, label: `不可用 · ${item.status}` };
  }

  // src/lib/steam/key-activation.js
  var STORE = "https://store.steampowered.com";
  var RESULTS = {
    9: "已拥有",
    13: "地区限制",
    14: "无效 Key",
    15: "已被使用",
    24: "缺少基础游戏",
    36: "需要 PS3 激活",
    50: "钱包/礼品卡代码",
    53: "Steam 限速"
  };
  function logKeyEvent(level, event, context = {}) {
    console[level]({ timestamp: (/* @__PURE__ */ new Date()).toISOString(), level, event, ...context });
  }
  async function getSteamSession(runId) {
    const response = await gmXhr({ method: "GET", url: STORE + "/" });
    if (response.status !== 200) throw new Error(`Steam 首页返回 HTTP ${response.status}`);
    const html = response.responseText;
    const account = html.match(/g_AccountID = (\d+)/);
    const session = html.match(/g_sessionID = "(\w+)"/);
    if (!account || Number(account[1]) === 0 || !session) {
      throw new Error("请先在当前浏览器登录 Steam 商店，再重试");
    }
    logKeyEvent("info", "steam_session_ready", { runId, accountId: account[1] });
    return session[1];
  }
  async function activateSteamKey(key, sessionId, runId) {
    const response = await gmXhr({
      method: "POST",
      url: STORE + "/account/ajaxregisterkey/",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: STORE,
        Referer: STORE + "/account/registerkey"
      },
      data: new URLSearchParams({ product_key: key, sessionid: sessionId }).toString()
    });
    logKeyEvent("info", "steam_key_response", { runId, key, status: response.status, response: response.responseText });
    if (response.status !== 200) throw new Error(`Steam 激活接口返回 HTTP ${response.status}`);
    const result = JSON.parse(response.responseText);
    const code = Number(result.purchase_result_details);
    return {
      state: result.success === 1 ? "success" : "failed",
      message: result.success === 1 ? "激活成功" : RESULTS[code] || `激活失败（代码 ${code}）`,
      stop: code === 53
    };
  }

  // src/lib/userscript/steam-key-toolbar.js
  var STEAM_KEY_PATTERN = /^(?:[A-Z0-9]{5}-){2,5}[A-Z0-9]{5}$/;

  // src/lib/digiphile/activation.js
  async function activateSelection(state, runId, update) {
    const selectedIds = [...state.selected];
    let currentItem = null;
    let success = 0;
    state.completed = 0;
    state.total = 0;
    log("info", "digiphile.activation_started", runId, { selectedIds });
    update("正在核对所选 Key…");
    try {
      state.items = await listSteamKeys(runId);
      const itemsById = new Map(state.items.map((item) => [item.id, item]));
      const availableIds = selectedIds.filter((id) => itemsById.has(id) && availability(itemsById.get(id)).available);
      state.selected = new Set(availableIds);
      if (availableIds.length !== selectedIds.length) {
        log("warn", "digiphile.activation_selection_changed", runId, { selectedIds, availableIds });
        update(`已取消选择 ${selectedIds.length - availableIds.length} 个不可用的 Key，请检查列表后重试。`, true);
        return;
      }
      if (state.stopping) return;
      const pending = availableIds.filter((id) => state.activations.get(id)?.state !== "success").map((id) => ({ ...itemsById.get(id), key: state.results.get(id)?.steamKeyValue.trim().toUpperCase() }));
      if (!pending.length) {
        log("info", "digiphile.activation_already_completed", runId);
        update("所选 Key 已全部激活成功。");
        return;
      }
      if (pending.some((item) => !item.key)) {
        log("warn", "digiphile.activation_unread_selection", runId);
        update("请先读取所选 Key。", true);
        return;
      }
      if (pending.some((item) => !STEAM_KEY_PATTERN.test(item.key))) {
        log("warn", "digiphile.activation_invalid_key", runId, { itemIds: pending.filter((item) => !STEAM_KEY_PATTERN.test(item.key)).map((item) => item.id) });
        update("所选 Key 格式不正确，请重新读取后重试。", true);
        return;
      }
      state.total = pending.length;
      update("正在检查 Steam 登录状态…");
      const session = await getSteamSession(runId);
      if (state.stopping) return;
      const unavailable = pending.find((item) => !availability(item).available);
      if (unavailable) throw new Error(`“${unavailable.title}”${availability(unavailable).label}，请刷新列表。`);
      if (!window.confirm(`将向当前浏览器已登录的 Steam 商店账号提交 ${pending.length} 个 Key。确认激活？`)) {
        log("info", "digiphile.activation_cancelled", runId);
        update("已取消。");
        return;
      }
      log("info", "digiphile.activation_confirmed", runId, { itemIds: pending.map((item) => item.id) });
      for (const item of pending) {
        if (state.stopping) break;
        currentItem = item;
        const info = availability(item);
        if (!info.available) throw new Error(`“${item.title}”${info.label}，请刷新列表。`);
        state.activations.set(item.id, { state: "pending", message: "正在激活…" });
        update(`${state.completed}/${state.total} · 正在激活：${item.title}`);
        const result = await activateSteamKey(item.key, session, runId);
        state.activations.set(item.id, result);
        state.completed += 1;
        if (result.state === "success") success += 1;
        log(result.state === "success" ? "info" : "warn", "digiphile.key_activation_result", runId, { itemId: item.id, ...result });
        update(`${state.completed}/${state.total} · ${item.title}：${result.message}`, result.state !== "success");
        if (result.stop) {
          update(`Steam 限速，已停止（已处理 ${state.completed}/${state.total}）。`, true);
          return;
        }
        if (state.stopping) break;
        if (state.completed < state.total) await new Promise((resolve) => setTimeout(resolve, 2e3));
      }
      if (!state.stopping) {
        log("info", "digiphile.activation_completed", runId, { completed: state.completed, total: state.total, success });
        update(`已处理 ${state.completed}/${state.total} 个 Key，成功 ${success} 个，未成功 ${state.completed - success} 个。`, success !== state.completed);
      }
    } catch (error) {
      if (currentItem) state.activations.set(currentItem.id, { state: "failed", message: `激活失败：${error.message}` });
      logError("digiphile.activation_failed", runId, error, { itemId: currentItem?.id, completed: state.completed });
      update(`激活失败（${state.completed}/${state.total}）：${error.message}`, true);
    } finally {
      if (state.stopping) {
        log("info", "digiphile.activation_stopped", runId, { completed: state.completed, total: state.total });
        if (!state.error) update(`已停止，已处理 ${state.completed}/${state.total} 个 Key。`);
      }
    }
  }

  // src/lib/digiphile/controller.js
  function createController(render) {
    const state = {
      items: [],
      selected: /* @__PURE__ */ new Set(),
      results: /* @__PURE__ */ new Map(),
      itemMessages: /* @__PURE__ */ new Map(),
      activations: /* @__PURE__ */ new Map(),
      loaded: false,
      busy: false,
      stopping: false,
      completed: 0,
      total: 0,
      message: "正在读取 Key 列表…",
      error: false
    };
    let activeRunId = null;
    function update(message, error = false) {
      state.message = message;
      state.error = error;
      render(state);
    }
    function select(mode) {
      if (state.busy) return;
      state.selected = new Set(state.items.filter((item) => {
        const info = availability(item);
        return mode === "all" ? info.available : mode === "new" && info.fresh;
      }).map((item) => item.id));
      render(state);
    }
    function toggle(id, checked) {
      if (state.busy) return;
      const item = state.items.find((value) => value.id === id);
      if (checked && item && availability(item).available) state.selected.add(id);
      else state.selected.delete(id);
      render(state);
    }
    async function refresh() {
      if (state.busy) return;
      const runId = crypto.randomUUID();
      activeRunId = runId;
      state.busy = true;
      state.stopping = false;
      update("正在读取 Key 列表…");
      log("info", "digiphile.list_started", runId);
      try {
        state.items = await listSteamKeys(runId);
        if (!state.loaded) {
          state.selected = new Set(state.items.filter((item) => availability(item).fresh).map((item) => item.id));
        } else {
          const availableIds = new Set(state.items.filter((item) => availability(item).available).map((item) => item.id));
          state.selected = new Set([...state.selected].filter((id) => availableIds.has(id)));
        }
        state.loaded = true;
        log("info", "digiphile.list_loaded", runId, { count: state.items.length });
        update(state.stopping ? "已停止，列表已更新。" : "列表已更新。");
      } catch (error) {
        logError("digiphile.list_failed", runId, error);
        update(`读取列表失败：${error.message}`, true);
      } finally {
        state.busy = false;
        state.stopping = false;
        activeRunId = null;
        render(state);
      }
    }
    function stop() {
      if (!state.busy || state.stopping) return;
      state.stopping = true;
      log("info", "digiphile.stop_requested", activeRunId);
      if (!state.error) update("当前请求完成后停止。");
      else render(state);
    }
    async function run() {
      if (state.busy || !state.selected.size) return;
      const runId = crypto.randomUUID();
      activeRunId = runId;
      const selectedIds = [...state.selected];
      state.busy = true;
      state.stopping = false;
      state.completed = 0;
      state.total = 0;
      let currentItem = null;
      log("info", "digiphile.batch_started", runId, {
        selected: state.items.filter((item) => state.selected.has(item.id)).map(({ id, title }) => ({ id, title }))
      });
      update("正在核对所选 Key…");
      try {
        state.items = await listSteamKeys(runId);
        if (state.stopping) return;
        const itemsById = new Map(state.items.map((item) => [item.id, item]));
        const invalidIds = selectedIds.filter((id) => !itemsById.has(id) || !availability(itemsById.get(id)).available);
        if (invalidIds.length) {
          state.selected = new Set(selectedIds.filter((id) => itemsById.has(id) && availability(itemsById.get(id)).available));
          log("warn", "digiphile.selection_changed", runId, { unavailableIds: invalidIds });
          update(`已取消选择 ${invalidIds.length} 个不可用的 Key，请检查列表后重试。`, true);
          return;
        }
        const pending = selectedIds.filter((id) => !state.results.has(id)).map((id) => itemsById.get(id));
        state.total = pending.length;
        if (!pending.length) {
          log("info", "digiphile.batch_already_read", runId);
          update("所选 Key 已全部读取。");
          return;
        }
        const newCount = pending.filter((item) => availability(item).fresh).length;
        const confirmation = newCount ? `本次读取 ${pending.length} 个 Key，其中 ${newCount} 个需刮开。
刮开后，所属整包不可退款，该 Key 不可兑换积分。
是否继续？` : `读取 ${pending.length} 个已刮开的 Key？`;
        if (!window.confirm(confirmation)) {
          log("info", "digiphile.batch_cancelled", runId);
          update("已取消。");
          return;
        }
        for (const item of pending) {
          if (state.stopping) break;
          currentItem = item;
          const info = availability(item);
          state.itemMessages.set(item.id, info.fresh ? "正在刮开…" : "正在读取…");
          update(`${state.completed}/${state.total} · ${info.fresh ? "正在刮开" : "正在读取"}：${item.title}`);
          const result = await readSteamKey(item, runId);
          state.results.set(item.id, { steamKeyValue: result.steamKeyValue, source: info.fresh ? "本次刮开" : "本次读取" });
          state.items = state.items.map((value) => value.id === item.id ? { ...value, status: "Revealed" } : value);
          state.itemMessages.delete(item.id);
          state.completed += 1;
          log("info", "digiphile.key_read", runId, { itemId: item.id, action: info.fresh ? "reveal" : "view" });
          render(state);
        }
        if (!state.stopping) {
          log("info", "digiphile.batch_completed", runId, { completed: state.completed });
          update(`已读取 ${state.completed}/${state.total} 个 Key。`);
        }
      } catch (error) {
        const uncertain = currentItem?.status === "Assigned";
        if (currentItem) state.itemMessages.set(currentItem.id, uncertain ? "刮开状态待核对" : "读取失败，请重试");
        logError("digiphile.batch_failed", runId, error, { itemId: currentItem?.id, completed: state.completed });
        update(`读取失败（${state.completed}/${state.total}）：${error.message}${uncertain ? " 请重试以核对刮开状态。" : ""}`, true);
      } finally {
        if (state.stopping) {
          log("info", "digiphile.batch_stopped", runId, { completed: state.completed, total: state.total });
          if (!state.error) update(`已停止，已读取 ${state.completed}/${state.total} 个 Key。`);
        }
        state.busy = false;
        state.stopping = false;
        activeRunId = null;
        render(state);
      }
    }
    async function activate() {
      if (state.busy || !state.selected.size) return;
      const runId = crypto.randomUUID();
      activeRunId = runId;
      state.busy = true;
      state.stopping = false;
      try {
        await activateSelection(state, runId, update);
      } finally {
        state.busy = false;
        state.stopping = false;
        activeRunId = null;
        render(state);
      }
    }
    function getResults() {
      return state.items.filter((item) => state.results.has(item.id) && availability(item).available).map((item) => ({ ...item, ...state.results.get(item.id) }));
    }
    function copy(withTitle) {
      const runId = crypto.randomUUID();
      const results = getResults();
      if (!results.length) {
        log("info", "digiphile.copy_unavailable", runId);
        update("没有可复制的 Key，请刷新列表。");
        return;
      }
      try {
        GM_setClipboard(results.map((item) => withTitle ? `${item.title}	${item.steamKeyValue}` : item.steamKeyValue).join("\n"), "text");
        log("info", "digiphile.keys_copied", runId, { count: results.length, withTitle });
        update(withTitle ? `已复制 ${results.length} 组游戏名与 Key。` : `已复制 ${results.length} 个 Key。`);
      } catch (error) {
        logError("digiphile.copy_failed", runId, error);
        update(`复制失败：${error.message}。请手动复制 Key。`, true);
      }
    }
    return { state, refresh, run, activate, stop, select, toggle, copy, getResults };
  }

  // src/lib/digiphile/panel.js
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function createPanel(controller) {
    const root = element("section", "", "dp-keys");
    root.id = "digiphile-steam-keys-helper";
    root.setAttribute("aria-label", "Digiphile Steam Key 工具");
    root.append(element("h2", "Steam Key 工具"));
    const actions = element("div", "", "dp-keys-actions");
    function button(text, handler) {
      const node = element("button", text);
      node.type = "button";
      node.addEventListener("click", handler);
      actions.append(node);
      return node;
    }
    const refresh = button("刷新列表", controller.refresh);
    const selectNew = button("仅选未刮开", () => controller.select("new"));
    const selectAll = button("全选可用", () => controller.select("all"));
    const clear = button("取消全选", () => controller.select("none"));
    const run = button("读取所选 Key", controller.run);
    run.className = "dp-keys-primary";
    const activate = button("激活所选 Key", controller.activate);
    const stop = button("停止", controller.stop);
    const copy = button("复制 Key", () => controller.copy(false));
    const copyTitles = button("复制游戏名与 Key", () => controller.copy(true));
    root.append(actions);
    const summary = element("p", "", "dp-keys-summary");
    const message = element("p", "", "dp-keys-message");
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    root.append(summary, message);
    const scroll = element("div", "", "dp-keys-scroll");
    const table = element("table");
    const head = element("thead");
    const headingRow = element("tr");
    for (const text of ["选择", "游戏", "状态", "Key", "激活结果"]) {
      const th = element("th", text);
      th.scope = "col";
      headingRow.append(th);
    }
    head.append(headingRow);
    const body = element("tbody");
    table.append(head, body);
    scroll.append(table);
    root.append(scroll);
    const rows = /* @__PURE__ */ new Map();
    function buildRow(id) {
      const row = element("tr");
      const choice = element("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.addEventListener("change", () => controller.toggle(id, checkbox.checked));
      choice.append(checkbox);
      const game = element("td");
      const title = element("div", "", "dp-keys-title");
      const expiry = element("div", "", "dp-keys-expiry");
      game.append(title, expiry);
      const status = element("td");
      const keyCell = element("td");
      const key = document.createElement("input");
      key.type = "text";
      key.readOnly = true;
      key.spellcheck = false;
      key.autocomplete = "off";
      key.className = "dp-keys-key";
      key.placeholder = "未读取";
      keyCell.append(key);
      const activation = element("td");
      row.append(choice, game, status, keyCell, activation);
      return { row, checkbox, title, expiry, status, key, activation };
    }
    function render(state) {
      const items = state.items.filter((item) => !isExpired(item));
      const results = new Map(controller.getResults().map((item) => [item.id, item]));
      const selectedCount = items.filter((item) => state.selected.has(item.id) && availability(item).available).length;
      const freshCount = items.filter((item) => availability(item).fresh).length;
      summary.textContent = `共 ${items.length} 个 Key · 可刮开 ${freshCount} 个 · 已选 ${selectedCount} 个 · 已读取 ${results.size} 个`;
      message.textContent = state.message;
      message.classList.toggle("dp-keys-error", state.error);
      for (const control of [refresh, selectNew, selectAll, clear]) control.disabled = state.busy;
      run.disabled = state.busy || !selectedCount;
      activate.disabled = state.busy || !selectedCount;
      stop.disabled = !state.busy || state.stopping;
      copy.disabled = copyTitles.disabled = state.busy || !results.size;
      const currentIds = new Set(items.map((item) => item.id));
      for (const [id, fields] of rows) {
        if (!currentIds.has(id)) {
          fields.row.remove();
          rows.delete(id);
        }
      }
      items.forEach((item, index) => {
        if (!rows.has(item.id)) rows.set(item.id, buildRow(item.id));
        const fields = rows.get(item.id);
        if (body.children[index] !== fields.row) body.insertBefore(fields.row, body.children[index] || null);
        const info = availability(item);
        const result = info.available ? results.get(item.id) : null;
        fields.checkbox.checked = info.available && state.selected.has(item.id);
        fields.checkbox.disabled = state.busy || !info.available;
        fields.checkbox.setAttribute("aria-label", `选择 ${item.title}`);
        fields.title.textContent = item.title;
        fields.expiry.textContent = item.expiresAt ? `到期时间：${new Date(item.expiresAt).toLocaleString()}` : "";
        fields.status.textContent = [info.label, info.available && (state.itemMessages.get(item.id) || result?.source)].filter(Boolean).join(" · ");
        const activation = state.activations.get(item.id);
        fields.activation.textContent = activation?.message || "";
        fields.activation.classList.toggle("dp-keys-error", activation?.state === "failed");
        fields.key.setAttribute("aria-label", `${item.title} 的 Key`);
        const key = result?.steamKeyValue || "";
        if (fields.key.value !== key) fields.key.value = key;
      });
    }
    render(controller.state);
    return { root, render };
  }

  // src/lib/digiphile/styles.js
  var styles = `
.dp-keys {
  box-sizing: border-box; padding: 18px; margin: 16px 0; width: 100%;
  border: 1px solid #617690; border-radius: 10px; background: #101c2c; color: #edf3fc;
  font: 14px/1.6 system-ui, sans-serif; text-align: left;
}
.dp-keys h2 { margin: 0 0 10px; font-size: 20px; font-weight: 700; color: #fff; }
.dp-keys p { margin: 8px 0; color: inherit; }
.dp-keys .dp-keys-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }
.dp-keys button {
  border: 1px solid #889bb6; border-radius: 5px; padding: 7px 12px;
  background: #24364d; color: #fff; cursor: pointer; font: inherit;
}
.dp-keys button.dp-keys-primary { background: #185e9e; }
.dp-keys button:disabled { opacity: .5; cursor: default; }
.dp-keys button:focus-visible, .dp-keys input:focus-visible { outline: 2px solid #f7c95e; outline-offset: 2px; }
.dp-keys .dp-keys-summary { font-weight: 600; }
.dp-keys .dp-keys-message { white-space: pre-wrap; overflow-wrap: anywhere; }
.dp-keys .dp-keys-error { color: #ffb4ad; }
.dp-keys .dp-keys-scroll { overflow-x: auto; max-height: 560px; overflow-y: auto; }
.dp-keys table { width: 100%; border-collapse: collapse; font: inherit; color: inherit; }
.dp-keys th, .dp-keys td { border-bottom: 1px solid #40536c; padding: 9px 8px; vertical-align: top; text-align: left; }
.dp-keys th { background: #1a2b41; position: sticky; top: 0; z-index: 1; white-space: nowrap; }
.dp-keys .dp-keys-title { min-width: 150px; overflow-wrap: anywhere; }
.dp-keys .dp-keys-expiry { color: #c1ccdc; font-size: 12px; }
.dp-keys input[type="checkbox"] { width: 18px; height: 18px; accent-color: #6eb4ff; }
.dp-keys .dp-keys-key {
  width: 260px; box-sizing: border-box; padding: 6px; border: 1px solid #617690; border-radius: 4px;
  background: #0b1421; color: #fff; font: 14px/1.5 ui-monospace, monospace; user-select: text;
}
`;

  // src/lib/digiphile/steam-keys.js
  function startDigiphileSteamKeys() {
    const lifecycleId = crypto.randomUUID();
    GM_addStyle(styles);
    let panel = null;
    let initialLoadStarted = false;
    let scheduled = false;
    const controller = createController((state) => panel?.render(state));
    function sync() {
      scheduled = false;
      if (location.pathname !== "/customer/library/steam-keys") {
        if (panel) {
          controller.stop();
          panel.root.remove();
          panel = null;
          log("info", "digiphile.panel_unmounted", lifecycleId);
        }
        return;
      }
      if (panel?.root.isConnected) return;
      const heading = [...document.querySelectorAll("h1")].find((node) => node.textContent.trim() === "My Steam Game Keys");
      if (!heading) return;
      const content = heading.parentElement.parentElement;
      if (![...content.querySelectorAll("h3")].some((node) => !node.textContent.startsWith("Available Keys"))) return;
      panel = createPanel(controller);
      heading.parentElement.after(panel.root);
      log("info", "digiphile.panel_mounted", lifecycleId);
      if (!initialLoadStarted) {
        initialLoadStarted = true;
        void controller.refresh();
      }
    }
    function scheduleSync() {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(sync);
    }
    new MutationObserver(scheduleSync).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", scheduleSync);
    log("info", "digiphile.helper_started", lifecycleId);
    sync();
  }

  // src/userscripts/digiphile-steam-keys.user.js
  startDigiphileSteamKeys();
})();
