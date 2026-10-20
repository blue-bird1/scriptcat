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
