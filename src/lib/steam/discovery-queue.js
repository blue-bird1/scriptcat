import {
  getModalQueueAction,
  startDiscoveryQueueAutoFilter,
} from "./discovery-queue-auto-filter.js";
import { createDiscoveryQueueStoreItemReader } from "./discovery-queue-store-items.js";

const QUEUE_TIMEOUT_MS = 10_000;
const ADVANCE_DELAY_MS = 50;
const CLASSIC_RESTART_DELAY_MS = 50;
const MODAL_RESTART_DELAY_MS = 60;
const CLASSIC_NEXT_SELECTOR =
  "#nextInDiscoveryQueue .btn_next_in_queue_trigger";
const MODAL_WISHLIST_PATH = "/api/addtowishlist";

function getDiscoveryQueueDialog() {
  return [...document.querySelectorAll('[role="dialog"]')].find((dialog) =>
    dialog.querySelector('a[href*="/explore"][href*="dq=widget"]'),
  );
}

function restartDiscoveryQueueIfNeeded(autoRestart) {
  if (typeof autoRestart === "function" ? autoRestart() !== true : autoRestart !== true) {
    return;
  }

  const dialog = getDiscoveryQueueDialog();
  if (dialog instanceof HTMLElement) {
    const queueLink = dialog.querySelector('a[href*="/explore"][href*="dq=widget"]');
    if (queueLink instanceof HTMLAnchorElement) {
      window.location.assign(queueLink.href);
      return;
    }
  }

  const isClassicQueue = new URLSearchParams(location.search).get("queue") === "1";
  if (isClassicQueue) {
    const nextQueueUrl = new URL(location.href);
    nextQueueUrl.searchParams.set("queue", "1");
    window.location.assign(nextQueueUrl.toString());
    return;
  }

  window.location.assign(`${location.origin}/explore`);
}

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

function startClassicQueue({ autoRestart = () => false } = {}) {
  if (new URLSearchParams(location.search).get("queue") !== "1") {
    return () => {};
  }

  const queueActions = document.querySelector("#queueActionsCtn");
  if (!(queueActions instanceof HTMLElement)) {
    return () => {};
  }

  let observer;
  let timer;
  let frame;
  const pendingActions = new Set();
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

  function advance(delay = ADVANCE_DELAY_MS) {
    stopWaiting();
    advancing = true;
    timer = setTimeout(() => {
      timer = undefined;
      const triggerNext = () => {
        frame = undefined;
        const currentNextButton = document.querySelector(CLASSIC_NEXT_SELECTOR);
        if (currentNextButton instanceof HTMLElement) {
          currentNextButton.click();
          advancing = false;
          return;
        }
        setTimeout(() => {
          restartDiscoveryQueueIfNeeded(autoRestart);
        }, CLASSIC_RESTART_DELAY_MS);
        advancing = false;
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
    for (const action of pendingActions) {
      if (hasSucceeded()) {
        advance();
        return;
      }

      if (hasFailed()) {
        pendingActions.delete(action);
      }
    }

    if (pendingActions.size === 0) {
      stopWaiting();
    }
  }

  function waitForResult(action) {
    if (advancing) {
      return;
    }

    pendingActions.add(action);
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
    timer = setTimeout(stopWaiting, QUEUE_TIMEOUT_MS);
  }

  function handleClick(event) {
    const { target } = event;
    if (matchesAction(target, "#add_to_wishlist_area a.add_to_wishlist")) {
      waitForResult("wishlist");
    } else if (
      matchesAction(target, ".queue_btn_ignore .queue_btn_inactive") ||
      matchesAction(target, "#queue_ignore_menu_option_not_interested") ||
      matchesAction(target, "#queue_ignore_menu_option_owned_elsewhere")
    ) {
      advance(0);
    }
  }

  function stop() {
    stopWaiting();
    queueActions.removeEventListener("click", handleClick, true);
    window.removeEventListener("pagehide", stop);
  }

  queueActions.addEventListener("click", handleClick, true);
  window.addEventListener("pagehide", stop, { once: true });
  return stop;
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

function monitorActionRequests(takePending, handleResult) {
  if (typeof window.fetch !== "function") {
    return () => {};
  }

  const originalFetch = window.fetch;
  function monitoredFetch(...args) {
    const response = Reflect.apply(originalFetch, this, args);
    let pathname;
    try {
      pathname = getMonitoredPath(args[0], args[1]);
    } catch {
      return response;
    }

    if (!pathname) {
      return response;
    }

    const pending = takePending(pathname);
    if (!pending) {
      return response;
    }

    return response.then(
      (result) => {
        handleResult(pending, result.ok);
        return result;
      },
      (error) => {
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

function startModalQueue({ autoRestart = () => false } = {}) {
  const requestQueues = new Map();
  const pendingActions = new Set();
  let advanceFrame;
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
      return;
    }

    advancing = true;
    clearPending();
    const deadline = performance.now() + QUEUE_TIMEOUT_MS;

    const triggerNext = () => {
      advanceFrame = undefined;
      if (!pending.dialog.isConnected) {
        advancing = false;
        return;
      }

      const nextButton = findModalNextButton(pending.dialog);
      if (nextButton) {
        nextButton.click();
        advancing = false;
        return;
      }

      if (typeof autoRestart === "function" ? autoRestart() : autoRestart) {
        advanceFrame = setTimeout(() => {
          restartDiscoveryQueueIfNeeded(autoRestart);
        }, MODAL_RESTART_DELAY_MS);
        return;
      }

      if (performance.now() >= deadline) {
        advancing = false;
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

      pending.stabilityTimer = setTimeout(() => {
        if (
          pending.button.isConnected &&
          pending.button.className !== pending.initialClassName
        ) {
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
        return;
      }

      if (succeeded) {
        waitForSelectedState(pending);
      } else {
        removePending(pending);
      }
    },
  );

  function handleClick(event) {
    const modalAction = getModalQueueAction(event.target);
    if (!modalAction || advancing) {
      return;
    }

    if (modalAction.action === "ignore") {
      advance(modalAction, true);
      return;
    }

    const pending = {
      ...modalAction,
      pathname: MODAL_WISHLIST_PATH,
    };
    pending.timer = setTimeout(() => removePending(pending), QUEUE_TIMEOUT_MS);
    pendingActions.add(pending);
    const queue = requestQueues.get(MODAL_WISHLIST_PATH) ?? [];
    queue.push(pending);
    requestQueues.set(MODAL_WISHLIST_PATH, queue);
  }

  function stop() {
    cancelAnimationFrame(advanceFrame);
    clearTimeout(advanceFrame);
    advanceFrame = undefined;
    advancing = false;
    stopMonitoringRequests();
    clearPending();
    document.removeEventListener("click", handleClick, true);
    window.removeEventListener("pagehide", stop);
  }

  document.addEventListener("click", handleClick, true);
  window.addEventListener("pagehide", stop, { once: true });
  return stop;
}

export function startSteamDiscoveryQueue() {
  const storeItemReader = createDiscoveryQueueStoreItemReader();
  let autoRestartQueue = false;
  const stopModalQueue = startModalQueue({
    autoRestart: () => autoRestartQueue,
  });
  let stopClassicQueue = () => {};
  let stopAutoFilter = () => {};
  let stopped = false;

  function startQueueControllersWhenReady() {
    if (!stopped) {
      stopClassicQueue = startClassicQueue({
        autoRestart: () => autoRestartQueue,
      });
      stopAutoFilter = startDiscoveryQueueAutoFilter({
        getStoreItem: storeItemReader.get,
        onConfigChange(config) {
          autoRestartQueue = Boolean(config?.autoRestartQueue);
        },
      });
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
    stopped = true;
    document.removeEventListener("DOMContentLoaded", startQueueControllersWhenReady);
    stopModalQueue();
    stopClassicQueue();
    stopAutoFilter();
    storeItemReader.stop();
  };
}
