import { createController } from "./controller.js";
import { createPanel } from "./panel.js";
import { log } from "./log.js";
import { styles } from "./styles.js";

export function startDigiphileSteamKeys() {
  const lifecycleId = crypto.randomUUID();
  GM_addStyle(styles);
  let panel = null;
  let initialLoadStarted = false;
  let scheduled = false;
  const controller = createController(state => panel?.render(state));

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
    const heading = [...document.querySelectorAll("h1")].find(node => node.textContent.trim() === "My Steam Game Keys");
    if (!heading) return;
    // 列表内容在客户端查询完成后出现；此时再挂载，避免改动服务端 DOM 导致 React 水合失败。
    const content = heading.parentElement.parentElement;
    if (![...content.querySelectorAll("h3")].some(node => !node.textContent.startsWith("Available Keys"))) return;
    panel = createPanel(controller);
    heading.before(panel.root);
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
