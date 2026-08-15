import { createDiscoveryQueueConfigUi } from "./discovery-queue-config.js";
import { createDiscoveryQueueRuleEngine } from "./discovery-queue-rules.js";

const QUEUE_OBSERVER_SELECTOR =
  '[role="dialog"], #queueActionsCtn, .discover_queue_empty';

function isVisible(element) {
  return Boolean(
    element &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden",
  );
}

function getAppId(url, logger) {
  try {
    return new URL(url, location.href).pathname.match(/^\/app\/(\d+)(?:\/|$)/)?.[1];
  } catch (error) {
    logger?.error("context.app_url_parse_failed", error, { url });
    return undefined;
  }
}

function parseReviewCount(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    return undefined;
  }

  const count = Number(value.trim());
  return Number.isSafeInteger(count) ? count : undefined;
}

function parsePositiveRate(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const match = value.match(/(?<![\d.,])(?<rate>\d{1,3}(?:[.,]\d+)?)\s*%/);
  if (!match?.groups) {
    return undefined;
  }

  const rate = Number(match.groups.rate.replace(",", "."));
  return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : undefined;
}

function getClassicReviews() {
  const summary = document.querySelector('.user_reviews_summary_row[itemprop="aggregateRating"]');
  if (!(summary instanceof HTMLElement)) {
    return undefined;
  }

  const reviewCount = parseReviewCount(summary.querySelector('meta[itemprop="reviewCount"]')?.content);
  const positiveRate = parsePositiveRate(summary.dataset.tooltipHtml);
  if (reviewCount === undefined && positiveRate === undefined) {
    return undefined;
  }

  const reviews = {};
  if (reviewCount !== undefined) {
    reviews.reviewCount = reviewCount;
  }
  if (positiveRate !== undefined) {
    reviews.positiveRate = positiveRate;
  }
  return reviews;
}

export function getModalQueueAction(target, logger) {
  if (!(target instanceof Element)) {
    return undefined;
  }

  const button = target.closest("[aria-label]");
  const actionGroup = button?.parentElement?.parentElement;
  const dialog = button?.closest('[role="dialog"]');
  const appLink = [...(actionGroup?.children ?? [])].find((child) =>
    child.matches?.('a[href*="/app/"]'),
  );
  if (
    !(button instanceof HTMLElement) ||
    !(actionGroup instanceof HTMLElement) ||
    !(dialog instanceof HTMLElement) ||
    !(appLink instanceof HTMLAnchorElement) ||
    !dialog.querySelector('a[href*="/explore"][href*="dq=widget"]')
  ) {
    return undefined;
  }

  const actionButtons = [...actionGroup.children]
    .map((child) => child.querySelector("[aria-label]"))
    .filter((element) => element instanceof HTMLElement);
  const actionIndex = actionButtons.indexOf(button);
  if (actionButtons.length !== 2 || actionIndex === -1) {
    return undefined;
  }

  return {
    action: actionIndex === 0 ? "wishlist" : "ignore",
    actionGroup,
    appId: getAppId(appLink.href, logger),
    button,
    dialog,
    initialClassName: button.className,
  };
}

function findCardRoot(actionGroup, dialog) {
  let current = actionGroup;
  while (current && current !== dialog) {
    if (current.querySelector('a[href*="/tags/"]')) {
      return current;
    }
    current = current.parentElement;
  }
  return actionGroup;
}

function getModalContext(logger) {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')];
  for (const dialog of dialogs) {
    const queueLink = dialog.querySelector('a[href*="/explore"][href*="dq=widget"]');
    const header = queueLink?.parentElement?.parentElement;
    if (!(header instanceof HTMLElement)) {
      continue;
    }

    const dialogRect = dialog.getBoundingClientRect();
    const candidates = [...dialog.querySelectorAll("[aria-label]")]
      .map((element) => getModalQueueAction(element, logger))
      .filter((action) => action?.action === "ignore" && action.appId)
      .filter(({ button }) => {
        const rect = button.getBoundingClientRect();
        return isVisible(button) && rect.left >= dialogRect.left && rect.right <= dialogRect.right;
      })
      .sort((left, right) => right.button.getBoundingClientRect().left - left.button.getBoundingClientRect().left);
    const current = candidates[0];
    if (!current) {
      return { buttonHost: header };
    }

    const cardRoot = findCardRoot(current.actionGroup, dialog);
    const tags = [...cardRoot.querySelectorAll('a[href*="/tags/"]')]
      .map((link) => link.textContent?.trim())
      .filter(Boolean);
    return {
      appId: current.appId,
      buttonHost: header,
      ignoreButton: current.button,
      key: `modal:${current.appId}:${tags.join("\u0000")}`,
      tags,
    };
  }
  return undefined;
}

function getClassicContext() {
  if (new URLSearchParams(location.search).get("queue") !== "1") {
    return undefined;
  }
  const appId = location.pathname.match(/^\/app\/(\d+)(?:\/|$)/)?.[1];
  const buttonHost = document.querySelector("#queueActionsCtn");
  if (!appId || !(buttonHost instanceof HTMLElement)) {
    return undefined;
  }
  const tags = [...document.querySelectorAll(".glance_tags a.app_tag")]
    .map((element) => element.textContent?.trim())
    .filter(Boolean);
  const reviews = getClassicReviews();
  return {
    appId,
    buttonHost,
    ignoreButton: document.querySelector(".queue_btn_ignore .queue_btn_inactive"),
    key: `classic:${appId}:${reviews?.reviewCount ?? ""}:${reviews?.positiveRate ?? ""}:${tags.join("\u0000")}`,
    reviews,
    tags,
  };
}

export function getModalContinueButton() {
  const dialog = document.querySelector(
    '[role="dialog"]:has(a[href*="/explore"][href*="dq=widget"])',
  );
  const wishlistLink = dialog?.querySelector('a[href*="/wishlist"]');
  const ignoredLink = dialog?.querySelector('a[href*="/account/notinterested"]');
  if (
    !(dialog instanceof HTMLElement) ||
    !(wishlistLink instanceof HTMLAnchorElement) ||
    !(ignoredLink instanceof HTMLAnchorElement)
  ) {
    return undefined;
  }

  const wishlistStatistic = wishlistLink.parentElement;
  const ignoredStatistic = ignoredLink.parentElement;
  const statisticsRoot = wishlistStatistic?.parentElement;
  if (
    !(statisticsRoot instanceof HTMLElement) ||
    ignoredStatistic?.parentElement !== statisticsRoot
  ) {
    return undefined;
  }

  const summaryContent = statisticsRoot.parentElement;
  const summaryCard = summaryContent?.parentElement;
  const actionParent = statisticsRoot.nextElementSibling;
  if (
    !(summaryContent instanceof HTMLElement) ||
    !(summaryCard instanceof HTMLElement) ||
    !summaryCard.matches('[role="button"][tabindex="0"]') ||
    !(actionParent instanceof HTMLElement) ||
    actionParent.parentElement !== summaryContent
  ) {
    return undefined;
  }

  const dialogRect = dialog.getBoundingClientRect();
  const summaryRect = summaryCard.getBoundingClientRect();
  const dialogCenter = dialogRect.left + dialogRect.width / 2;
  if (
    !isVisible(summaryCard) ||
    summaryRect.left > dialogCenter ||
    summaryRect.right < dialogCenter
  ) {
    return undefined;
  }

  const actions = [...actionParent.children].filter(
    (element) => element instanceof HTMLElement && isVisible(element),
  );
  return actions.length === 2 ? actions[1] : undefined;
}

function getClassicContinueLink(logger) {
  if (new URLSearchParams(location.search).get("queue") !== "1") {
    return undefined;
  }

  const emptyQueue = [...document.querySelectorAll(".discover_queue_empty")].find(
    isVisible,
  );
  if (!(emptyQueue instanceof HTMLElement)) {
    return undefined;
  }

  return [...emptyQueue.querySelectorAll("a[href]")].find((link) => {
    if (!(link instanceof HTMLAnchorElement) || !isVisible(link)) {
      return false;
    }
    try {
      const url = new URL(link.href, location.href);
      return (
        url.origin === location.origin &&
        /^\/explore\/startnew\/0\/?$/.test(url.pathname)
      );
    } catch (error) {
      logger?.error("auto_continue.url_parse_failed", error, { href: link.href });
      return false;
    }
  });
}

export function startDiscoveryQueueAutoFilter({ getStoreItem, logger } = {}) {
  const autoLogger = logger?.child("auto-filter");
  const ruleEngine = createDiscoveryQueueRuleEngine({ getStoreItem });
  const continuedModalButtons = new WeakSet();
  const continuedClassicLinks = new WeakSet();
  const loggedModalSuppressions = new WeakSet();
  const loggedClassicSuppressions = new WeakSet();
  const modalContinueActionIds = new WeakMap();
  const classicContinueActionIds = new WeakMap();
  let stopped = false;
  let paused = false;
  let scheduled = false;
  let generation = 0;
  let evaluatedKey;
  let observedContextKey;
  let activeConfig;

  const configUi = createDiscoveryQueueConfigUi({
    logger: autoLogger,
    onSave() {
      activeConfig = configUi.getConfig();
      generation += 1;
      evaluatedKey = undefined;
      autoLogger?.info("config.saved", {
        autoContinueQueue: activeConfig.autoContinueQueue,
        enabled: activeConfig.enabled,
        generation,
      });
      schedule();
    },
    onOpenChange(open) {
      paused = open;
      autoLogger?.info("config.pause_changed", { paused });
      if (!open) {
        schedule();
      }
    },
  });

  activeConfig = configUi.getConfig();

  function getContext() {
    return getModalContext(autoLogger) ?? getClassicContext();
  }

  async function evaluateCurrent() {
    scheduled = false;
    const config = activeConfig ?? configUi.getConfig();
    if (paused) {
      autoLogger?.debug("evaluation.skipped", { reason: "config-open" });
      return;
    }

    if (config.autoContinueQueue) {
      const modalContinueButton = getModalContinueButton();
      if (
        modalContinueButton instanceof HTMLElement &&
        !continuedModalButtons.has(modalContinueButton)
      ) {
        const actionId = autoLogger?.nextId("auto-continue");
        continuedModalButtons.add(modalContinueButton);
        modalContinueActionIds.set(modalContinueButton, actionId);
        autoLogger?.info("auto_continue.clicked", { actionId, mode: "modal" });
        modalContinueButton.click();
        return;
      } else if (
        modalContinueButton instanceof HTMLElement &&
        !loggedModalSuppressions.has(modalContinueButton)
      ) {
        loggedModalSuppressions.add(modalContinueButton);
        autoLogger?.debug("auto_continue.duplicate_suppressed", {
          actionId: modalContinueActionIds.get(modalContinueButton),
          mode: "modal",
        });
      }

      const classicContinueLink = getClassicContinueLink(autoLogger);
      if (
        classicContinueLink instanceof HTMLAnchorElement &&
        !continuedClassicLinks.has(classicContinueLink)
      ) {
        const actionId = autoLogger?.nextId("auto-continue");
        continuedClassicLinks.add(classicContinueLink);
        classicContinueActionIds.set(classicContinueLink, actionId);
        autoLogger?.info("auto_continue.clicked", { actionId, mode: "classic" });
        classicContinueLink.click();
        return;
      } else if (
        classicContinueLink instanceof HTMLAnchorElement &&
        !loggedClassicSuppressions.has(classicContinueLink)
      ) {
        loggedClassicSuppressions.add(classicContinueLink);
        autoLogger?.debug("auto_continue.duplicate_suppressed", {
          actionId: classicContinueActionIds.get(classicContinueLink),
          mode: "classic",
        });
      }
    }

    const context = getContext();
    if (!context) {
      return;
    }
    if (context.key !== observedContextKey) {
      autoLogger?.info("context.changed", {
        appId: context.appId,
        from: observedContextKey,
        mode: context.key?.split(":", 1)[0],
        to: context.key,
      });
      observedContextKey = context.key;
    }
    configUi.ensureButton(context.buttonHost);
    if (!config.enabled || !context.appId || context.key === evaluatedKey) {
      return;
    }

    evaluatedKey = context.key;
    const currentGeneration = ++generation;
    const evaluationId = autoLogger?.nextId("evaluation");
    autoLogger?.info("evaluation.started", {
      appId: context.appId,
      evaluationId,
      generation: currentGeneration,
      key: context.key,
    });
    let result;
    try {
      result = await ruleEngine.evaluate({
        appId: context.appId,
        reviews: context.reviews,
        tags: context.tags,
        config,
      });
      autoLogger?.info("evaluation.completed", {
        appId: context.appId,
        evaluationId,
        matched: result.matched,
        result,
      });
    } catch (error) {
      autoLogger?.error("evaluation.failed", error, {
        appId: context.appId,
        evaluationId,
        generation: currentGeneration,
      });
      return;
    }
    if (stopped || paused || currentGeneration !== generation) {
      autoLogger?.info("evaluation.stale", {
        currentGeneration: generation,
        evaluationGeneration: currentGeneration,
        evaluationId,
        paused,
        stopped,
      });
      return;
    }
    if (!result.matched) {
      return;
    }
    const current = getContext();
    if (current?.key === context.key && current.ignoreButton instanceof HTMLElement) {
      autoLogger?.info("evaluation.ignore_clicked", {
        appId: context.appId,
        evaluationId,
        key: context.key,
      });
      current.ignoreButton.click();
    } else {
      autoLogger?.info("evaluation.context_changed_before_action", {
        appId: context.appId,
        currentKey: current?.key,
        evaluationId,
        expectedKey: context.key,
      });
    }
  }

  function schedule() {
    if (stopped || scheduled) {
      return;
    }
    scheduled = true;
    requestAnimationFrame(evaluateCurrent);
  }

  const observer = new MutationObserver((records) => {
    const relevant = records.some((record) => {
      if (
        record.target instanceof Element &&
        record.target.closest(QUEUE_OBSERVER_SELECTOR)
      ) {
        return true;
      }
      return [...record.addedNodes].some(
        (node) =>
          node instanceof Element &&
          (node.matches(QUEUE_OBSERVER_SELECTOR) ||
            node.querySelector(QUEUE_OBSERVER_SELECTOR)),
      );
    });
    if (relevant) {
      schedule();
    }
  });
  observer.observe(document, {
    attributes: true,
    attributeFilter: ["class", "style"],
    childList: true,
    subtree: true,
  });
  schedule();
  autoLogger?.info("controller.started", { enabled: activeConfig.enabled });

  return () => {
    stopped = true;
    generation += 1;
    observer.disconnect();
    configUi.destroy();
    ruleEngine.clear();
    autoLogger?.info("controller.stopped");
  };
}
