// ==UserScript==
// @name         Digiphile Steam Key Helper
// @namespace    https://github.com/blue-bird1/scriptcat
// @version      1.0.1
// @description  批量刮开、读取和复制 Digiphile Steam Key
// @author       blue-bird1
// @match        https://www.digiphile.co/customer/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      api.digiphile.co
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
    const action = item.status === "Revealed" ? "view" : "reveal";
    const body = await request("POST", `/customer/steam-keys/${encodeURIComponent(item.id)}/${action}`, runId, (value) => {
      if (typeof value?.steamKeyValue !== "string" || !value.steamKeyValue.trim()) {
        throw new Error("Digiphile 响应缺少有效 Key，请刷新列表后重试。");
      }
    });
    return { ...item, status: "Revealed", steamKeyValue: body.steamKeyValue };
  }
  function availability(item, now = Date.now()) {
    if (item.isGift) return { available: false, fresh: false, label: "礼物，请在站点处理" };
    if (item.status === "Revealed") return { available: true, fresh: false, label: "已刮开" };
    if (item.status === "Assigned") {
      if (item.expiresAt && Date.parse(item.expiresAt) <= now) {
        return { available: false, fresh: false, label: "已过期" };
      }
      return { available: true, fresh: true, label: "未刮开" };
    }
    return { available: false, fresh: false, label: `不可用 · ${item.status}` };
  }

  // src/lib/digiphile/controller.js
  function createController(render) {
    const state = {
      items: [],
      selected: /* @__PURE__ */ new Set(),
      results: /* @__PURE__ */ new Map(),
      itemMessages: /* @__PURE__ */ new Map(),
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
      if (checked) state.selected.add(id);
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
      update("当前请求完成后停止。");
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
        const pendingIds = selectedIds.filter((id) => !state.results.has(id));
        const invalidIds = pendingIds.filter((id) => !itemsById.has(id) || !availability(itemsById.get(id)).available);
        if (invalidIds.length) {
          state.selected = new Set(selectedIds.filter((id) => itemsById.has(id) && availability(itemsById.get(id)).available));
          log("warn", "digiphile.selection_changed", runId, { unavailableIds: invalidIds });
          update(`已取消选择 ${invalidIds.length} 个不可用的 Key，请检查列表后重试。`, true);
          return;
        }
        const pending = pendingIds.map((id) => itemsById.get(id));
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
          if (!info.available) throw new Error(`“${item.title}”已不可用，请刷新列表。`);
          state.itemMessages.set(item.id, info.fresh ? "正在刮开…" : "正在读取…");
          update(`${state.completed}/${state.total} · ${info.fresh ? "正在刮开" : "正在读取"}：${item.title}`);
          const result = await readSteamKey(item, runId);
          state.results.set(item.id, { ...result, source: info.fresh ? "本次刮开" : "本次读取" });
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
          update(`已停止，已读取 ${state.completed}/${state.total} 个 Key。`, state.error);
        }
        state.busy = false;
        state.stopping = false;
        activeRunId = null;
        render(state);
      }
    }
    function copy(withTitle) {
      const runId = crypto.randomUUID();
      const results = [...state.results.values()];
      if (!results.length) return;
      try {
        GM_setClipboard(results.map((item) => withTitle ? `${item.title}	${item.steamKeyValue}` : item.steamKeyValue).join("\n"), "text");
        log("info", "digiphile.keys_copied", runId, { count: results.length, withTitle });
        update(withTitle ? `已复制 ${results.length} 组游戏名与 Key。` : `已复制 ${results.length} 个 Key。`);
      } catch (error) {
        logError("digiphile.copy_failed", runId, error);
        update(`复制失败：${error.message}。请手动复制 Key。`, true);
      }
    }
    return { state, refresh, run, stop, select, toggle, copy };
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
    for (const text of ["选择", "游戏", "状态", "Key"]) {
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
      row.append(choice, game, status, keyCell);
      return { row, checkbox, title, expiry, status, key };
    }
    function render(state) {
      const selectedCount = state.selected.size;
      const freshCount = state.items.filter((item) => availability(item).fresh).length;
      summary.textContent = `共 ${state.items.length} 个 Key · 可刮开 ${freshCount} 个 · 已选 ${selectedCount} 个 · 已读取 ${state.results.size} 个`;
      message.textContent = state.message;
      message.classList.toggle("dp-keys-error", state.error);
      for (const control of [refresh, selectNew, selectAll, clear]) control.disabled = state.busy;
      run.disabled = state.busy || !selectedCount;
      stop.disabled = !state.busy || state.stopping;
      copy.disabled = copyTitles.disabled = state.busy || !state.results.size;
      const listedIds = new Set(state.items.map((item) => item.id));
      const items = [...state.items, ...[...state.results.values()].filter((item) => !listedIds.has(item.id))];
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
        const result = state.results.get(item.id);
        fields.checkbox.checked = state.selected.has(item.id);
        fields.checkbox.disabled = state.busy || !info.available || !listedIds.has(item.id);
        fields.checkbox.setAttribute("aria-label", `选择 ${item.title}`);
        fields.title.textContent = item.title;
        fields.expiry.textContent = item.expiresAt ? `到期时间：${new Date(item.expiresAt).toLocaleString()}` : "";
        fields.status.textContent = [info.label, state.itemMessages.get(item.id) || result?.source].filter(Boolean).join(" · ");
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
