export const DISCOVERY_QUEUE_DIALOG_SELECTOR =
  '[role="dialog"]:has(a[href*="/explore"][href*="dq=widget"])';
const PANEL_ID = "scriptcat-steam-discovery-queue-progress";

export function getDiscoveryQueueDialog() {
  const dialog = document.querySelector(DISCOVERY_QUEUE_DIALOG_SELECTOR);
  return dialog instanceof HTMLElement ? dialog : undefined;
}

function getProgressHost() {
  return getDiscoveryQueueDialog() ??
    (document.body instanceof HTMLElement ? document.body : undefined);
}

function canUseDom() {
  return typeof document?.createElement === "function";
}

function applyOverlayStyle(element) {
  element.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "padding:24px",
    "background:rgba(12,18,26,.88)",
    "color:#d6d7d8",
    "font:16px/1.5 Arial,sans-serif",
    "pointer-events:none",
  ].join(";");
}

function applyCardStyle(card) {
  card.style.cssText = [
    "box-sizing:border-box",
    "max-width:420px",
    "width:min(420px,100%)",
    "padding:20px 24px",
    "border:1px solid rgba(103,193,245,.45)",
    "border-radius:6px",
    "background:rgba(20,30,40,.98)",
    "box-shadow:0 8px 24px rgba(0,0,0,.45)",
  ].join(";");
}

export function createDiscoveryQueueProgress() {
  let element;
  let titleNode;
  let stageNode;
  let statsNode;
  let hidden = false;

  function ensureElement() {
    if (hidden || !canUseDom()) {
      return undefined;
    }
    const host = getProgressHost();
    if (!host) {
      return undefined;
    }
    if (!(element instanceof HTMLElement) || !element.isConnected) {
      const existing = document.getElementById(PANEL_ID);
      element = existing instanceof HTMLElement ? existing : document.createElement("div");
      element.id = PANEL_ID;
      element.setAttribute("role", "status");
      element.setAttribute("aria-live", "polite");
      if (!(existing instanceof HTMLElement)) {
        titleNode = document.createElement("div");
        titleNode.textContent = "Steam 探索队列";
        titleNode.style.cssText = "margin-bottom:8px;color:#67c1f5;font-weight:700";
        stageNode = document.createElement("div");
        statsNode = document.createElement("div");
        statsNode.style.cssText = "margin-top:8px;color:#8f98a0;font-size:14px";
        const card = document.createElement("div");
        applyCardStyle(card);
        card.append(titleNode, stageNode, statsNode);
        element.append(card);
      } else {
        titleNode = element.querySelector("[data-progress-title]");
        stageNode = element.querySelector("[data-progress-stage]");
        statsNode = element.querySelector("[data-progress-stats]");
      }
      titleNode?.setAttribute("data-progress-title", "");
      stageNode?.setAttribute("data-progress-stage", "");
      statsNode?.setAttribute("data-progress-stats", "");
    }
    applyOverlayStyle(element);
    if (element.parentElement !== host) {
      host.append(element);
    }
    return element;
  }

  function show({ stage, stats } = {}) {
    hidden = false;
    const target = ensureElement();
    if (!target) {
      return;
    }
    if (stageNode && stage !== undefined) {
      stageNode.textContent = stage;
    }
    if (statsNode && stats !== undefined) {
      statsNode.textContent = stats;
    }
  }

  function hide() {
    hidden = true;
    element?.remove();
    element = undefined;
    titleNode = undefined;
    stageNode = undefined;
    statsNode = undefined;
    if (typeof document?.getElementById === "function") {
      document.getElementById(PANEL_ID)?.remove();
    }
  }

  return { show, hide };
}

export function createPrefilterReporter() {
  const progress = createDiscoveryQueueProgress();
  let checked = 0;
  let ignored = 0;
  let total = 0;
  let batches = 0;

  function statsText() {
    return `已检查 ${checked}/${total}，已忽略 ${ignored}`;
  }

  function render(stage) {
    progress.show({
      stage,
      stats: `第 ${Math.max(batches, 1)} 轮 · ${statsText()}`,
    });
  }

  return {
    beginBatch(appIds) {
      batches += 1;
      total += appIds.length;
      render(`正在加载第 ${batches} 轮（${appIds.length} 项）`);
    },
    beginNextRound() {
      render("正在取下一轮");
      console.info(
        `[Steam 探索队列] 第 ${batches} 轮已全部过滤，正在取下一轮`,
      );
    },
    beginEvaluation() {
      render(`正在筛选第 ${batches} 轮`);
    },
    recordEvaluation(appId, result) {
      checked += 1;
      render(`正在筛选第 ${batches} 轮 · App ${appId}`);
      if (result?.matched === true) {
        console.info(
          `[Steam 探索队列] App ${appId} 命中筛选规则：${result.reasons.join("、")}`,
        );
      }
    },
    recordIgnore(appId, succeeded) {
      if (succeeded) {
        ignored += 1;
        render(`正在忽略第 ${batches} 轮命中项 · App ${appId}`);
        console.info(`[Steam 探索队列] 已忽略 App ${appId}`);
      }
    },
    finishBatch(retainedAppIds, matchedAppIds) {
      render(
        retainedAppIds.length > 0
          ? `第 ${batches} 轮筛选完成，准备展示 ${retainedAppIds.length} 项`
          : `第 ${batches} 轮已全部过滤`,
      );
      console.info(
        `[Steam 探索队列] 第 ${batches} 轮筛选完成：筛除 ${matchedAppIds.length} 项，保留 ${retainedAppIds.length} 项`,
      );
    },
    close() {
      progress.hide();
    },
  };
}
