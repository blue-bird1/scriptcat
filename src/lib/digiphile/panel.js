import { availability } from "./api.js";

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function createPanel(controller) {
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
  const rows = new Map();

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
    const freshCount = state.items.filter(item => availability(item).fresh).length;
    summary.textContent = `共 ${state.items.length} 个 Key · 可刮开 ${freshCount} 个 · 已选 ${selectedCount} 个 · 已读取 ${state.results.size} 个`;
    message.textContent = state.message;
    message.classList.toggle("dp-keys-error", state.error);
    for (const control of [refresh, selectNew, selectAll, clear]) control.disabled = state.busy;
    run.disabled = state.busy || !selectedCount;
    stop.disabled = !state.busy || state.stopping;
    copy.disabled = copyTitles.disabled = state.busy || !state.results.size;

    const listedIds = new Set(state.items.map(item => item.id));
    const items = [...state.items, ...[...state.results.values()].filter(item => !listedIds.has(item.id))];
    const currentIds = new Set(items.map(item => item.id));
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
