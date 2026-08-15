import {
  getModalQueueAction,
  startDiscoveryQueueAutoFilter,
} from "./discovery-queue-auto-filter.js";
import { startDiscoveryQueuePrefilter } from "./discovery-queue-prefilter.js";
import { createDiscoveryQueueStoreItemReader } from "./discovery-queue-store-items.js";

const QUEUE_TIMEOUT_MS = 10_000;
const ADVANCE_DELAY_MS = 50;
const CLASSIC_NEXT_SELECTOR =
  "#nextInDiscoveryQueue .btn_next_in_queue_trigger";
const MODAL_WISHLIST_PATH = "/api/addtowishlist";
const MODAL_QUEUE_SELECTOR =
  '[role="dialog"]:has(a[href*="/explore"][href*="dq=widget"])';

function isVisible(element) {
  return Boolean(
    element &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden",
  );
}

function matchesAction(target, selector) {
  return target instanceof Element && target.closest(selector) !== null;
}

function startClassicQueue(logger) {
  if (new URLSearchParams(location.search).get("queue") !== "1") {
    logger?.debug("controller.skipped", { reason: "not-classic-queue" });
    return () => {};
  }

  const queueActions = document.querySelector("#queueActionsCtn");
  const nextButton = document.querySelector(CLASSIC_NEXT_SELECTOR);
  if (!(queueActions instanceof HTMLElement) || !(nextButton instanceof HTMLElement)) {
    logger?.debug("controller.skipped", { reason: "controls-not-found" });
    return () => {};
  }

  let observer;
  let timer;
  let frame;
  const pendingActions = new Set();
  let activeAdvance;
  let advancing = false;

  function stopWaiting() {
    observer?.disconnect();
    observer = undefined;
    clearTimeout(timer);
    timer = undefined;
    cancelAnimationFrame(frame);
    frame = undefined;
    pendingActions.clear();
  }

  function advance(pending, delay = ADVANCE_DELAY_MS) {
    if (advancing) {
      logger?.debug("advance.suppressed", {
        actionId: pending?.actionId,
        reason: "already-advancing",
      });
      return;
    }
    stopWaiting();
    advancing = true;
    activeAdvance = pending;
    logger?.info("advance.scheduled", {
      action: pending?.action,
      actionId: pending?.actionId,
      delay,
    });
    timer = setTimeout(() => {
      timer = undefined;
      const triggerNext = () => {
        frame = undefined;
        const currentNextButton = document.querySelector(CLASSIC_NEXT_SELECTOR);
        if (currentNextButton instanceof HTMLElement) {
          currentNextButton.click();
          logger?.info("advance.clicked", {
            action: pending?.action,
            actionId: pending?.actionId,
          });
        } else {
          logger?.warn("advance.button_missing", {
            action: pending?.action,
            actionId: pending?.actionId,
          });
        }
        advancing = false;
        activeAdvance = undefined;
      };
      if (delay === 0) {
        triggerNext();
      } else {
        frame = requestAnimationFrame(triggerNext);
      }
    }, delay);
  }

  function hasSucceeded() {
    return isVisible(document.querySelector("#add_to_wishlist_area_success")) && !isVisible(document.querySelector("#add_to_wishlist_area_fail"));
  }

  function hasFailed() {
    return isVisible(document.querySelector("#add_to_wishlist_area_fail"));
  }

  function checkResults() {
    for (const pending of pendingActions) {
      if (hasSucceeded()) {
        logger?.info("wishlist.succeeded", { actionId: pending.actionId });
        advance(pending);
        return;
      }

      if (hasFailed()) {
        logger?.warn("wishlist.failed", { actionId: pending.actionId });
        pendingActions.delete(pending);
      }
    }

    if (pendingActions.size === 0) {
      stopWaiting();
    }
  }

  function waitForResult(pending) {
    if (advancing) {
      logger?.debug("action.suppressed", {
        action: pending.action,
        actionId: pending.actionId,
        reason: "advancing",
      });
      return;
    }
    if ([...pendingActions].some((action) => action.action === pending.action)) {
      logger?.debug("action.suppressed", {
        action: pending.action,
        actionId: pending.actionId,
        reason: "already-pending",
      });
      return;
    }

    pendingActions.add(pending);
    logger?.info("wishlist.waiting", { actionId: pending.actionId });
    if (observer) {
      return;
    }

    observer = new MutationObserver(checkResults);
    observer.observe(queueActions, {
      attributes: true,
      attributeFilter: ["class", "style"],
      childList: true,
      subtree: true,
    });
    timer = setTimeout(() => {
      for (const action of pendingActions) {
        logger?.warn("wishlist.timeout", { actionId: action.actionId });
      }
      stopWaiting();
    }, QUEUE_TIMEOUT_MS);
  }

  function handleClick(event) {
    const { target } = event;
    if (matchesAction(target, "#add_to_wishlist_area a.add_to_wishlist")) {
      const pending = {
        action: "wishlist",
        actionId: logger?.nextId("classic-action"),
      };
      logger?.info("action.clicked", pending);
      waitForResult(pending);
    } else if (
      matchesAction(target, ".queue_btn_ignore .queue_btn_inactive") ||
      matchesAction(target, "#queue_ignore_menu_option_not_interested") ||
      matchesAction(target, "#queue_ignore_menu_option_owned_elsewhere")
    ) {
      const pending = {
        action: "ignore",
        actionId: logger?.nextId("classic-action"),
      };
      logger?.info("action.clicked", pending);
      advance(pending, 0);
    }
  }

  function stop() {
    logger?.info("controller.stopping", {
      advancing,
      pendingCount: pendingActions.size,
    });
    if (activeAdvance) {
      logger?.info("advance.cancelled", {
        action: activeAdvance.action,
        actionId: activeAdvance.actionId,
        reason: "controller-stop",
      });
    }
    for (const pending of pendingActions) {
      logger?.info("action.cancelled", {
        action: pending.action,
        actionId: pending.actionId,
        reason: "controller-stop",
      });
    }
    stopWaiting();
    activeAdvance = undefined;
    queueActions.removeEventListener("click", handleClick, true);
    window.removeEventListener("pagehide", stop);
  }

  queueActions.addEventListener("click", handleClick, true);
  window.addEventListener("pagehide", stop, { once: true });
  logger?.info("controller.started");
  return stop;
}

function startModalReviewCountFix(logger) {
  const root = document.body;
  if (!(root instanceof HTMLElement)) {
    return () => {};
  }

  function normalize() {
    const dialog = document.querySelector(MODAL_QUEUE_SELECTOR);
    if (!(dialog instanceof HTMLElement)) {
      return;
    }
    for (const element of dialog.querySelectorAll("[aria-label]")) {
      if (element.childElementCount > 0) {
        continue;
      }
      const match = element.textContent?.trim().match(/^\(\((.+)\)\)$/u);
      if (match) {
        const previousText = element.textContent;
        element.textContent = `(${match[1]})`;
        logger?.info("review_count.corrected", {
          correctedText: element.textContent,
          previousText,
          reviewCount: match[1],
        });
      }
    }
  }

  const observer = new MutationObserver(normalize);
  observer.observe(root, { characterData: true, childList: true, subtree: true });
  normalize();
  return () => observer.disconnect();
}

function findModalNextButton(dialog) {
  const dialogRect = dialog.getBoundingClientRect();
  const dialogCenter = dialogRect.left + dialogRect.width / 2;
  const dialogMiddle = dialogRect.top + dialogRect.height / 2;
  const maximumEdgeGap = Math.min(320, dialogRect.width * 0.15);
  const maximumMiddleGap = Math.min(240, dialogRect.height * 0.2);
  const candidates = [
    ...dialog.querySelectorAll('[role="button"][aria-label]'),
  ]
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return { element, rect };
    })
    .filter(
      ({ rect }) =>
        rect.width >= 40 &&
        rect.width <= 96 &&
        rect.height >= 40 &&
        rect.height <= 96,
    )
    .filter(
      ({ element, rect }) =>
        isVisible(element) &&
        rect.left + rect.width / 2 > dialogCenter &&
        dialogRect.right - rect.right <= maximumEdgeGap &&
        Math.abs(rect.top + rect.height / 2 - dialogMiddle) <=
          maximumMiddleGap,
    )
    .sort(
      (left, right) =>
        dialogRect.right -
          left.rect.right -
          (dialogRect.right - right.rect.right) ||
        Math.abs(left.rect.top + left.rect.height / 2 - dialogMiddle) -
          Math.abs(right.rect.top + right.rect.height / 2 - dialogMiddle),
    );

  return candidates[0]?.element;
}

function getMonitoredPath(input, init) {
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method.toUpperCase() !== "POST") {
    return undefined;
  }

  const rawUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(rawUrl, location.href);
  if (url.origin !== location.origin) {
    return undefined;
  }

  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return pathname === MODAL_WISHLIST_PATH ? pathname : undefined;
}

function monitorActionRequests(logger, takePending, handleResult) {
  if (typeof window.fetch !== "function") {
    logger?.warn("fetch.monitor_unavailable");
    return () => {};
  }

  const originalFetch = window.fetch;
  function monitoredFetch(...args) {
    let response;
    try {
      response = Reflect.apply(originalFetch, this, args);
    } catch (error) {
      logger?.error("fetch.call_failed", error, {
        input: args[0],
        init: args[1],
      });
      throw error;
    }
    let pathname;
    try {
      pathname = getMonitoredPath(args[0], args[1]);
    } catch (error) {
      logger?.error("fetch.inspect_failed", error, {
        input: args[0],
        init: args[1],
      });
      return response;
    }

    if (!pathname) {
      return response;
    }

    const pending = takePending(pathname);
    if (!pending) {
      logger?.warn("fetch.pending_missing", { pathname });
      return response;
    }
    logger?.info("fetch.matched", {
      actionId: pending.actionId,
      pathname,
    });

    return response.then(
      (result) => {
        logger?.info("fetch.completed", {
          actionId: pending.actionId,
          ok: result.ok,
          pathname,
          status: result.status,
        });
        handleResult(pending, result.ok);
        return result;
      },
      (error) => {
        logger?.error("fetch.failed", error, {
          actionId: pending.actionId,
          pathname,
        });
        handleResult(pending, false);
        throw error;
      },
    );
  }

  window.fetch = monitoredFetch;
  return () => {
    if (window.fetch === monitoredFetch) {
      window.fetch = originalFetch;
    }
  };
}

function startModalQueue(logger) {
  const requestQueues = new Map();
  const pendingActions = new Set();
  let advanceFrame;
  let activeAdvance;
  let advancing = false;

  function removePending(pending) {
    clearTimeout(pending.timer);
    clearTimeout(pending.stabilityTimer);
    pending.observer?.disconnect();
    pendingActions.delete(pending);

    const queue = requestQueues.get(pending.pathname);
    const index = queue?.indexOf(pending) ?? -1;
    if (index !== -1) {
      queue.splice(index, 1);
      if (queue.length === 0) {
        requestQueues.delete(pending.pathname);
      }
    }
  }

  function clearPending() {
    for (const pending of [...pendingActions]) {
      removePending(pending);
    }
  }

  function advance(pending, immediate = false) {
    if (advancing) {
      logger?.debug("advance.suppressed", {
        actionId: pending.actionId,
        reason: "already-advancing",
      });
      return;
    }

    advancing = true;
    activeAdvance = pending;
    clearPending();
    const deadline = performance.now() + QUEUE_TIMEOUT_MS;
    logger?.info("advance.started", {
      action: pending.action,
      actionId: pending.actionId,
      immediate,
    });

    const triggerNext = () => {
      advanceFrame = undefined;
      if (!pending.dialog.isConnected) {
        advancing = false;
        activeAdvance = undefined;
        logger?.warn("advance.cancelled", {
          actionId: pending.actionId,
          reason: "dialog-disconnected",
        });
        return;
      }

      const nextButton = findModalNextButton(pending.dialog);
      if (nextButton) {
        nextButton.click();
        advancing = false;
        activeAdvance = undefined;
        logger?.info("advance.clicked", { actionId: pending.actionId });
        return;
      }

      if (performance.now() >= deadline) {
        advancing = false;
        activeAdvance = undefined;
        logger?.warn("advance.timeout", { actionId: pending.actionId });
        return;
      }
      advanceFrame = requestAnimationFrame(triggerNext);
    };
    if (immediate) {
      triggerNext();
    } else {
      advanceFrame = requestAnimationFrame(triggerNext);
    }
  }

  function waitForSelectedState(pending) {
    function checkState() {
      clearTimeout(pending.stabilityTimer);
      if (
        !pending.button.isConnected ||
        pending.button.className === pending.initialClassName
      ) {
        return;
      }
      if (!pending.selectedStateDetected) {
        pending.selectedStateDetected = true;
        logger?.debug("selected_state.detected", {
          actionId: pending.actionId,
        });
      }

      pending.stabilityTimer = setTimeout(() => {
        if (
          pending.button.isConnected &&
          pending.button.className !== pending.initialClassName
        ) {
          logger?.info("selected_state.confirmed", {
            actionId: pending.actionId,
          });
          advance(pending);
        }
      }, ADVANCE_DELAY_MS);
    }

    pending.observer = new MutationObserver(checkState);
    pending.observer.observe(pending.button, {
      attributes: true,
      attributeFilter: ["class"],
    });
    checkState();
  }

  const stopMonitoringRequests = monitorActionRequests(
    logger,
    (pathname) => {
      const queue = requestQueues.get(pathname);
      const pending = queue?.shift();
      if (!pending) {
        return undefined;
      }

      if (queue.length === 0) {
        requestQueues.delete(pathname);
      }
      return pending;
    },
    (pending, succeeded) => {
      if (!pendingActions.has(pending)) {
        logger?.debug("fetch.result_ignored", {
          actionId: pending.actionId,
          reason: "pending-cancelled",
        });
        return;
      }

      if (succeeded) {
        logger?.info("action.request_succeeded", {
          actionId: pending.actionId,
        });
        waitForSelectedState(pending);
      } else {
        logger?.warn("action.request_failed", {
          actionId: pending.actionId,
        });
        removePending(pending);
      }
    },
  );

  function handleClick(event) {
    const modalAction = getModalQueueAction(event.target, logger);
    if (!modalAction) {
      return;
    }
    modalAction.actionId = logger?.nextId("modal-action");
    if (advancing) {
      logger?.debug("action.suppressed", {
        action: modalAction.action,
        actionId: modalAction.actionId,
        appId: modalAction.appId,
        reason: "advancing",
      });
      return;
    }
    logger?.info("action.clicked", {
      action: modalAction.action,
      actionId: modalAction.actionId,
      appId: modalAction.appId,
    });

    if (modalAction.action === "ignore") {
      advance(modalAction, true);
      return;
    }

    const pending = {
      ...modalAction,
      pathname: MODAL_WISHLIST_PATH,
    };
    pending.timer = setTimeout(() => {
      logger?.warn("action.pending_timeout", {
        actionId: pending.actionId,
        pathname: pending.pathname,
      });
      removePending(pending);
    }, QUEUE_TIMEOUT_MS);
    pendingActions.add(pending);
    const queue = requestQueues.get(MODAL_WISHLIST_PATH) ?? [];
    queue.push(pending);
    requestQueues.set(MODAL_WISHLIST_PATH, queue);
  }

  function stop() {
    logger?.info("controller.stopping", {
      advancing,
      pendingCount: pendingActions.size,
    });
    if (activeAdvance) {
      logger?.info("advance.cancelled", {
        actionId: activeAdvance.actionId,
        reason: "controller-stop",
      });
    }
    for (const pending of pendingActions) {
      logger?.info("action.cancelled", {
        action: pending.action,
        actionId: pending.actionId,
        appId: pending.appId,
        reason: "controller-stop",
      });
    }
    cancelAnimationFrame(advanceFrame);
    advanceFrame = undefined;
    activeAdvance = undefined;
    advancing = false;
    stopMonitoringRequests();
    clearPending();
    document.removeEventListener("click", handleClick, true);
    window.removeEventListener("pagehide", stop);
  }

  document.addEventListener("click", handleClick, true);
  window.addEventListener("pagehide", stop, { once: true });
  logger?.info("controller.started");
  return stop;
}

export function startSteamDiscoveryQueue({ logger } = {}) {
  const runLogger = logger?.child("run");
  runLogger?.info("lifecycle.started", {
    documentReadyState: document.readyState,
  });
  const storeItemReader = createDiscoveryQueueStoreItemReader({
    logger: runLogger?.child("store-items"),
  });
  const stopPrefilter = startDiscoveryQueuePrefilter({
    getLocalizedTags: storeItemReader.getLocalizedTags,
    getStoreItem: storeItemReader.get,
    prepareStoreItems: storeItemReader.prepareBatch,
    logger: runLogger?.child("prefilter"),
  });
  const stopModalQueue = startModalQueue(runLogger?.child("modal"));
  let stopClassicQueue = () => {};
  let stopAutoFilter = () => {};
  let stopReviewCountFix = () => {};
  let stopped = false;

  function startQueueControllersWhenReady() {
    if (!stopped) {
      runLogger?.info("controllers.starting", {
        documentReadyState: document.readyState,
      });
      stopClassicQueue = startClassicQueue(runLogger?.child("classic"));
      stopAutoFilter = startDiscoveryQueueAutoFilter({
        getStoreItem: storeItemReader.get,
        logger: runLogger,
      });
      stopReviewCountFix = startModalReviewCountFix(
        runLogger?.child("modal-review-count"),
      );
      runLogger?.info("controllers.started");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startQueueControllersWhenReady, {
      once: true,
    });
  } else {
    startQueueControllersWhenReady();
  }

  return () => {
    runLogger?.info("lifecycle.stopping");
    stopped = true;
    document.removeEventListener("DOMContentLoaded", startQueueControllersWhenReady);
    stopModalQueue();
    stopPrefilter();
    stopClassicQueue();
    stopAutoFilter();
    stopReviewCountFix();
    storeItemReader.stop();
    runLogger?.info("lifecycle.stopped");
  };
}
