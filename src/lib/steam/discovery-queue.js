const QUEUE_TIMEOUT_MS = 10_000;
const ADVANCE_DELAY_MS = 250;
const CLASSIC_NEXT_SELECTOR =
  "#nextInDiscoveryQueue .btn_next_in_queue_trigger";
const MODAL_ACTION_PATHS = {
  wishlist: "/api/addtowishlist",
  ignore: "/recommended/ignorerecommendation",
};

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

function startClassicQueue() {
  if (new URLSearchParams(location.search).get("queue") !== "1") {
    return () => {};
  }

  const queueActions = document.querySelector("#queueActionsCtn");
  const nextButton = document.querySelector(CLASSIC_NEXT_SELECTOR);
  if (!(queueActions instanceof HTMLElement) || !(nextButton instanceof HTMLElement)) {
    return () => {};
  }

  let observer;
  let timer;
  const pendingActions = new Set();
  let advancing = false;

  function stopWaiting() {
    observer?.disconnect();
    observer = undefined;
    clearTimeout(timer);
    timer = undefined;
    pendingActions.clear();
  }

  function advance() {
    stopWaiting();
    advancing = true;
    timer = setTimeout(() => {
      requestAnimationFrame(() => {
        const currentNextButton = document.querySelector(CLASSIC_NEXT_SELECTOR);
        if (currentNextButton instanceof HTMLElement) {
          currentNextButton.click();
        }
        advancing = false;
      });
    }, ADVANCE_DELAY_MS);
  }

  function hasSucceeded(action) {
    if (action === "wishlist") {
      return isVisible(document.querySelector("#add_to_wishlist_area_success")) && !isVisible(document.querySelector("#add_to_wishlist_area_fail"));
    }

    return isVisible(document.querySelector(".queue_btn_ignore .queue_btn_active")) && !isVisible(document.querySelector(".queue_btn_ignore .queue_btn_inactive"));
  }

  function hasFailed(action) {
    return action === "wishlist" && isVisible(document.querySelector("#add_to_wishlist_area_fail"));
  }

  function checkResults() {
    for (const action of pendingActions) {
      if (hasSucceeded(action)) {
        advance();
        return;
      }

      if (hasFailed(action)) {
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
      waitForResult("ignore");
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

function getModalAction(target) {
  if (!(target instanceof Element)) {
    return undefined;
  }

  const button = target.closest("[aria-label]");
  const actionGroup = button?.parentElement?.parentElement;
  const dialog = button?.closest('[role="dialog"]');
  if (
    !(button instanceof HTMLElement) ||
    !(actionGroup instanceof HTMLElement) ||
    !(dialog instanceof HTMLElement) ||
    !dialog.querySelector('a[href*="/explore"][href*="dq=widget"]') ||
    ![...actionGroup.children].some((child) =>
      child.matches('a[href*="/app/"]'),
    )
  ) {
    return undefined;
  }

  const actionButtons = [...actionGroup.children]
    .map((child) => child.querySelector("[aria-label]"))
    .filter((element) => element instanceof HTMLElement);
  if (actionButtons.length !== 2) {
    return undefined;
  }

  const actionIndex = actionButtons.indexOf(button);
  if (actionIndex === -1) {
    return undefined;
  }

  return {
    action: actionIndex === 0 ? "wishlist" : "ignore",
    button,
    dialog,
    initialClassName: button.className,
  };
}

function findModalNextButton(dialog) {
  const dialogRect = dialog.getBoundingClientRect();
  const dialogCenter = dialogRect.left + dialogRect.width / 2;
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
    );

  let bestPair;
  for (const left of candidates) {
    if (left.rect.left + left.rect.width / 2 >= dialogCenter) {
      continue;
    }

    for (const right of candidates) {
      if (
        right.rect.left + right.rect.width / 2 <= dialogCenter ||
        !isVisible(right.element) ||
        Math.abs(left.rect.top - right.rect.top) > 2 ||
        Math.abs(left.rect.width - right.rect.width) > 2 ||
        Math.abs(left.rect.height - right.rect.height) > 2
      ) {
        continue;
      }

      const score =
        Math.abs(left.rect.left - dialogRect.left) +
        Math.abs(dialogRect.right - right.rect.right);
      if (!bestPair || score < bestPair.score) {
        bestPair = { element: right.element, score };
      }
    }
  }

  return bestPair?.element;
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
  return Object.values(MODAL_ACTION_PATHS).includes(pathname)
    ? pathname
    : undefined;
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

function startModalQueue() {
  const requestQueues = new Map();
  const pendingActions = new Set();
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

  function advance(pending) {
    if (advancing) {
      return;
    }

    advancing = true;
    clearPending();
    requestAnimationFrame(() => {
      if (pending.dialog.isConnected) {
        findModalNextButton(pending.dialog)?.click();
      }
      advancing = false;
    });
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
    const modalAction = getModalAction(event.target);
    if (!modalAction || advancing) {
      return;
    }

    const pathname = MODAL_ACTION_PATHS[modalAction.action];
    const pending = {
      ...modalAction,
      pathname,
    };
    pending.timer = setTimeout(() => removePending(pending), QUEUE_TIMEOUT_MS);
    pendingActions.add(pending);
    const queue = requestQueues.get(pathname) ?? [];
    queue.push(pending);
    requestQueues.set(pathname, queue);
  }

  function stop() {
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
  const stopModalQueue = startModalQueue();
  let stopClassicQueue = () => {};
  let stopped = false;

  function startClassicQueueWhenReady() {
    if (!stopped) {
      stopClassicQueue = startClassicQueue();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startClassicQueueWhenReady, {
      once: true,
    });
  } else {
    startClassicQueueWhenReady();
  }

  return () => {
    stopped = true;
    document.removeEventListener("DOMContentLoaded", startClassicQueueWhenReady);
    stopModalQueue();
    stopClassicQueue();
  };
}
