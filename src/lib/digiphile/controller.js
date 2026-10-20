import { availability, listSteamKeys, readSteamKey } from "./api.js";
import { log, logError } from "./log.js";

export function createController(render) {
  const state = {
    items: [], selected: new Set(), results: new Map(), itemMessages: new Map(),
    loaded: false, busy: false, stopping: false, completed: 0, total: 0,
    message: "正在读取 Key 列表…", error: false,
  };
  // 未获得成功响应的 reveal 不能直接重发；后续只能在列表确认 Revealed 后 view。
  const attemptedReveals = new Set();
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
    update("正在读取全部 Key 列表…");
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
      update(state.stopping ? "已停止。列表已更新。" : `已读取全部 ${state.items.length} 项。默认仅选择未过期、自有且未刮开的 Key。`);
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
    update("正在停止：当前请求完成后停止，已取得的 Key 会保留。");
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
    update("正在重新核对所选条目的最新状态…");
    try {
      state.items = await listSteamKeys(runId);
      if (state.stopping) return;
      const itemsById = new Map(state.items.map(item => [item.id, item]));
      const pendingIds = selectedIds.filter(id => !state.results.has(id));
      const invalidIds = pendingIds.filter(id => !itemsById.has(id) || !availability(itemsById.get(id)).available);
      if (invalidIds.length) {
        state.selected = new Set(selectedIds.filter(id => itemsById.has(id) && availability(itemsById.get(id)).available));
        log("warn", "digiphile.selection_changed", runId, { unavailableIds: invalidIds });
        update(`${invalidIds.length} 个所选条目已不可用，已取消勾选。请检查列表后重试。`, true);
        return;
      }
      const pending = pendingIds.map(id => itemsById.get(id));
      state.total = pending.length;
      if (!pending.length) {
        log("info", "digiphile.batch_already_read", runId);
        update("所选 Key 均已显示，可直接复制。");
        return;
      }
      const unresolved = pending.find(item => availability(item).fresh && attemptedReveals.has(item.id));
      if (unresolved) {
        log("warn", "digiphile.reveal_unconfirmed", runId, { itemId: unresolved.id });
        update(`“${unresolved.title}”上次刮开结果尚未确认，当前仍显示未刮开。请稍后刷新列表，确认已刮开后再读取；本页不会重发该刮开请求。`, true);
        return;
      }
      const newCount = pending.filter(item => availability(item).fresh).length;
      const confirmation = newCount
        ? `即将首次刮开 ${newCount} 个 Key，并读取 ${pending.length - newCount} 个已刮开 Key。\n\n首次刮开会使对应整包不可退款、不可换积分。\n本脚本不会打开 Steam，也不会在 Steam 激活。\n\n是否继续？`
        : `即将读取 ${pending.length} 个已刮开 Key，不会打开 Steam 或激活。是否继续？`;
      if (!window.confirm(confirmation)) {
        log("info", "digiphile.batch_cancelled", runId);
        update("已取消，未刮开或读取任何 Key。");
        return;
      }
      for (const item of pending) {
        if (state.stopping) break;
        currentItem = item;
        const info = availability(item);
        // 有效期可能在确认框打开期间结束，发出 reveal 前再次核对。
        if (!info.available) throw new Error(`“${item.title}”已不可用，请刷新列表。`);
        state.itemMessages.set(item.id, info.fresh ? "正在刮开…" : "正在读取…");
        update(`${state.completed}/${state.total} · ${info.fresh ? "正在刮开" : "正在读取"}：${item.title}`);
        if (info.fresh) attemptedReveals.add(item.id);
        const result = await readSteamKey(item, runId);
        state.results.set(item.id, { ...result, source: info.fresh ? "本次新刮开" : "已刮开 · 已读取" });
        state.items = state.items.map(value => value.id === item.id ? { ...value, status: "Revealed" } : value);
        state.itemMessages.delete(item.id);
        attemptedReveals.delete(item.id);
        state.completed += 1;
        log("info", "digiphile.key_read", runId, { itemId: item.id, action: info.fresh ? "reveal" : "view" });
        render(state);
      }
      if (!state.stopping) {
        log("info", "digiphile.batch_completed", runId, { completed: state.completed });
        update(`完成 ${state.completed}/${state.total}。已取得的 Key 可在下方选择文本或复制。`);
      }
    } catch (error) {
      const uncertain = currentItem && attemptedReveals.has(currentItem.id);
      if (currentItem) state.itemMessages.set(currentItem.id, uncertain ? "刮开结果待核对 · 重试前刷新列表" : "读取失败 · 可重试");
      logError("digiphile.batch_failed", runId, error, { itemId: currentItem?.id, completed: state.completed });
      update(`已停止（${state.completed}/${state.total}）：${error.message}${uncertain ? " 刮开可能已完成；重试会先核对列表，已刮开项改为读取，不重复刮开。" : ""} 已取得的 Key 已保留。`, true);
    } finally {
      if (state.stopping) {
        log("info", "digiphile.batch_stopped", runId, { completed: state.completed, total: state.total });
        update(`已停止（${state.completed}/${state.total}），已取得的 Key 已保留。`, state.error);
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
      GM_setClipboard(results.map(item => withTitle ? `${item.title}\t${item.steamKeyValue}` : item.steamKeyValue).join("\n"), "text");
      log("info", "digiphile.keys_copied", runId, { count: results.length, withTitle });
      update(`已复制 ${results.length} 个已显示 Key${withTitle ? "（标题与 Key 以制表符分隔）" : ""}。`);
    } catch (error) {
      logError("digiphile.copy_failed", runId, error);
      update(`复制失败：${error.message}。可在下方选择 Key 文本手动复制。`, true);
    }
  }

  return { state, refresh, run, stop, select, toggle, copy };
}
