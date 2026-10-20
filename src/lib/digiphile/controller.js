import { availability, listSteamKeys, readSteamKey } from "./api.js";
import { log, logError } from "./log.js";

export function createController(render) {
  const state = {
    items: [], selected: new Set(), results: new Map(), itemMessages: new Map(),
    loaded: false, busy: false, stopping: false, completed: 0, total: 0,
    message: "正在读取 Key 列表…", error: false,
  };
  let activeRunId = null;

  function update(message, error = false) {
    state.message = message;
    state.error = error;
    render(state);
  }

  function select(mode) {
    if (state.busy) return;
    state.selected = new Set(state.items.filter(item => {
      const info = availability(item);
      return mode === "all" ? info.available : mode === "new" && info.fresh;
    }).map(item => item.id));
    render(state);
  }

  function toggle(id, checked) {
    if (state.busy) return;
    const item = state.items.find(value => value.id === id);
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
        state.selected = new Set(state.items.filter(item => availability(item).fresh).map(item => item.id));
      } else {
        const availableIds = new Set(state.items.filter(item => availability(item).available).map(item => item.id));
        state.selected = new Set([...state.selected].filter(id => availableIds.has(id)));
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
      selected: state.items.filter(item => state.selected.has(item.id)).map(({ id, title }) => ({ id, title })),
    });
    update("正在核对所选 Key…");
    try {
      state.items = await listSteamKeys(runId);
      if (state.stopping) return;
      const itemsById = new Map(state.items.map(item => [item.id, item]));
      const invalidIds = selectedIds.filter(id => !itemsById.has(id) || !availability(itemsById.get(id)).available);
      if (invalidIds.length) {
        state.selected = new Set(selectedIds.filter(id => itemsById.has(id) && availability(itemsById.get(id)).available));
        log("warn", "digiphile.selection_changed", runId, { unavailableIds: invalidIds });
        update(`已取消选择 ${invalidIds.length} 个不可用的 Key，请检查列表后重试。`, true);
        return;
      }
      const pending = selectedIds.filter(id => !state.results.has(id)).map(id => itemsById.get(id));
      state.total = pending.length;
      if (!pending.length) {
        log("info", "digiphile.batch_already_read", runId);
        update("所选 Key 已全部读取。");
        return;
      }
      const newCount = pending.filter(item => availability(item).fresh).length;
      const confirmation = newCount
        ? `本次读取 ${pending.length} 个 Key，其中 ${newCount} 个需刮开。\n刮开后，所属整包不可退款，该 Key 不可兑换积分。\n是否继续？`
        : `读取 ${pending.length} 个已刮开的 Key？`;
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
        state.items = state.items.map(value => value.id === item.id ? { ...value, status: "Revealed" } : value);
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

  function getResults() {
    return state.items.filter(item => state.results.has(item.id) && availability(item).available)
      .map(item => ({ ...item, ...state.results.get(item.id) }));
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
      GM_setClipboard(results.map(item => withTitle ? `${item.title}\t${item.steamKeyValue}` : item.steamKeyValue).join("\n"), "text");
      log("info", "digiphile.keys_copied", runId, { count: results.length, withTitle });
      update(withTitle ? `已复制 ${results.length} 组游戏名与 Key。` : `已复制 ${results.length} 个 Key。`);
    } catch (error) {
      logError("digiphile.copy_failed", runId, error);
      update(`复制失败：${error.message}。请手动复制 Key。`, true);
    }
  }

  return { state, refresh, run, stop, select, toggle, copy, getResults };
}
