import { activateSteamKey, getSteamSession } from "../steam/key-activation.js";
import { STEAM_KEY_PATTERN } from "../userscript/steam-key-toolbar.js";
import { availability, listSteamKeys } from "./api.js";
import { log, logError } from "./log.js";

export async function activateSelection(state, runId, update) {
  const selectedIds = [...state.selected];
  let currentItem = null;
  let success = 0;
  state.completed = 0;
  state.total = 0;
  log("info", "digiphile.activation_started", runId, { selectedIds });
  update("正在核对所选 Key…");
  try {
    state.items = await listSteamKeys(runId);
    const itemsById = new Map(state.items.map(item => [item.id, item]));
    const availableIds = selectedIds.filter(id => itemsById.has(id) && availability(itemsById.get(id)).available);
    state.selected = new Set(availableIds);
    if (availableIds.length !== selectedIds.length) {
      log("warn", "digiphile.activation_selection_changed", runId, { selectedIds, availableIds });
      update(`已取消选择 ${selectedIds.length - availableIds.length} 个不可用的 Key，请检查列表后重试。`, true);
      return;
    }
    if (state.stopping) return;
    const pending = availableIds.filter(id => state.activations.get(id)?.state !== "success")
      .map(id => ({ ...itemsById.get(id), key: state.results.get(id)?.steamKeyValue.trim().toUpperCase() }));
    if (!pending.length) {
      log("info", "digiphile.activation_already_completed", runId);
      update("所选 Key 已全部激活成功。");
      return;
    }
    if (pending.some(item => !item.key)) {
      log("warn", "digiphile.activation_unread_selection", runId);
      update("请先读取所选 Key。", true);
      return;
    }
    if (pending.some(item => !STEAM_KEY_PATTERN.test(item.key))) {
      log("warn", "digiphile.activation_invalid_key", runId, { itemIds: pending.filter(item => !STEAM_KEY_PATTERN.test(item.key)).map(item => item.id) });
      update("所选 Key 格式不正确，请重新读取后重试。", true);
      return;
    }
    state.total = pending.length;
    update("正在检查 Steam 登录状态…");
    const session = await getSteamSession(runId);
    if (state.stopping) return;
    const unavailable = pending.find(item => !availability(item).available);
    if (unavailable) throw new Error(`“${unavailable.title}”${availability(unavailable).label}，请刷新列表。`);
    if (!window.confirm(`将向当前浏览器已登录的 Steam 商店账号提交 ${pending.length} 个 Key。确认激活？`)) {
      log("info", "digiphile.activation_cancelled", runId);
      update("已取消。");
      return;
    }
    log("info", "digiphile.activation_confirmed", runId, { itemIds: pending.map(item => item.id) });
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
      if (state.completed < state.total) await new Promise(resolve => setTimeout(resolve, 2000));
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
