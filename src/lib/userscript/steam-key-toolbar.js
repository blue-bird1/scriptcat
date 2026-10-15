import { activateSteamKey, getSteamSession, logKeyEvent } from "../steam/key-activation.js";

const ID = "scriptcat-steam-key-toolbar";
export const STEAM_KEY_PATTERN = /^(?:[A-Z0-9]{5}-){2,5}[A-Z0-9]{5}$/;

// 站点适配器只提供已显示的 Key、标题节点与工具栏挂载点。
export function startSteamKeyToolbar({ collectItems, getAnchor }) {
  if (document.getElementById(ID)) return;
  let toolbar;
  let summary;
  let results;
  let running = false;
  let signature = "";
  const controls = [];
  const runId = crypto.randomUUID();

  function items() {
    const seen = new Set();
    return collectItems().filter(item => {
      item.key = item.key.trim().toUpperCase();
      if (!STEAM_KEY_PATTERN.test(item.key) || seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    });
  }

  function report(text) { summary.textContent = text; }

  function showError(event, error) {
    logKeyEvent("error", event, { runId, message: error.message, stack: error.stack, response: error.response });
    report(error.message);
  }

  function button(text, handler) {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = text;
    node.addEventListener("click", handler);
    controls.push(node);
    return node;
  }

  function copy(includeTitles) {
    const list = items();
    if (!list.length) { report("没有找到已显示的 Steam Key，请先在站点展开或领取 Key"); return; }
    const text = list.map(item => includeTitles ? `${item.title}\t${item.key}` : item.key).join("\n");
    try {
      GM_setClipboard(text, "text");
      logKeyEvent("info", "keys_copied", { runId, count: list.length, includeTitles });
      report(`已复制 ${list.length} 个 Steam Key`);
    } catch (error) { showError("key_copy_failed", error); }
  }

  function mark(item, message, state) {
    const line = document.createElement("li");
    line.textContent = `${item.title}：${message}`;
    line.dataset.state = state;
    results.append(line);
    let badge = item.node.querySelector(".scriptcat-key-result");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "scriptcat-key-result";
      item.titleNode.insertAdjacentElement("afterend", badge);
    }
    badge.textContent = message;
    badge.dataset.state = state;
  }

  async function activate() {
    if (running) return;
    const list = items();
    if (!list.length) { report("没有找到可激活的 Steam Key"); return; }
    if (!window.confirm(`将向当前登录的 Steam 账号提交 ${list.length} 个 Key。确认激活？`)) return;
    running = true;
    controls.forEach(node => { node.disabled = true; });
    results.textContent = "";
    let done = 0;
    let success = 0;
    try {
      report("正在检查 Steam 登录状态…");
      const session = await getSteamSession(runId);
      logKeyEvent("info", "key_activation_started", { runId, count: list.length });
      for (const item of list) {
        report(`正在激活 ${done + 1}/${list.length}：${item.title}`);
        const result = await activateSteamKey(item.key, session, runId);
        done += 1;
        if (result.state === "success") success += 1;
        mark(item, result.message, result.state);
        if (result.stop) break;
        if (done < list.length) await new Promise(resolve => setTimeout(resolve, 2000));
      }
      report(`已处理 ${done}/${list.length}，成功 ${success}，未成功 ${done - success}${done < list.length ? "；Steam 限速，已停止" : ""}`);
      logKeyEvent("info", "key_activation_finished", { runId, done, success, total: list.length });
    } catch (error) {
      showError("key_activation_failed", error);
      report(`已停止（已处理 ${done}/${list.length}）：${error.message}`);
    } finally {
      running = false;
      controls.forEach(node => { node.disabled = false; });
    }
  }

  function render() {
    const anchor = getAnchor();
    if (!anchor) return;
    if (!toolbar) {
      toolbar = document.createElement("section");
      toolbar.id = ID;
      toolbar.setAttribute("aria-label", "Steam Key 工具");
      const title = document.createElement("h3");
      title.textContent = "Steam Key 工具";
      const actions = document.createElement("div");
      actions.className = "scriptcat-key-actions";
      actions.append(button("复制全部 Key", () => copy(false)), button("复制标题 + Key", () => copy(true)), button("激活全部", activate));
      const hint = document.createElement("p");
      hint.textContent = "仅处理当前页面已显示的 Key；激活前请先登录 Steam 商店。";
      summary = document.createElement("p");
      summary.setAttribute("role", "status");
      results = document.createElement("ul");
      toolbar.append(title, actions, hint, summary, results);
      logKeyEvent("info", "key_toolbar_ready", { runId, url: location.href });
    }
    if (!toolbar.isConnected) anchor.insertAdjacentElement("beforebegin", toolbar);
    const list = items();
    const next = list.map(item => item.title + "\t" + item.key).join("\n");
    if (!running && (next !== signature || !summary.textContent)) {
      signature = next;
      report(`检测到 ${list.length} 个 Steam Key`);
      logKeyEvent("info", "keys_detected", { runId, count: list.length });
    }
  }

  GM_addStyle(`
    #${ID} { margin:16px 0; padding:16px; border:1px solid #64748b; border-radius:8px; background:#fff; color:#1f2937; font:14px/1.5 sans-serif; width:100%; box-sizing:border-box; }
    #${ID} h3 { margin:0 0 12px; font-size:18px; color:inherit; }
    #${ID} p { margin:8px 0; color:inherit; }
    #${ID} .scriptcat-key-actions { display:flex; flex-wrap:wrap; gap:8px; }
    #${ID} button { padding:8px 12px; border:0; border-radius:5px; background:#0f766e; color:#fff; cursor:pointer; font:inherit; }
    #${ID} button:disabled { opacity:.5; cursor:wait; }
    #${ID} ul { max-height:200px; overflow:auto; padding-left:22px; }
    .scriptcat-key-result { display:block; margin:4px; font:13px/1.5 sans-serif; }
    #${ID} [data-state="success"], .scriptcat-key-result[data-state="success"] { color:#059669; }
    #${ID} [data-state="failed"], .scriptcat-key-result[data-state="failed"] { color:#e11d48; }
  `);
  const observer = new MutationObserver(mutations => {
    if (mutations.every(m => toolbar?.contains(m.target) || m.target.closest?.(".scriptcat-key-result"))) return;
    render();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  render();
}
