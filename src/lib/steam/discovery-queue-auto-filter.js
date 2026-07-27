import { createDiscoveryQueueConfigUi } from "./discovery-queue-config.js";
import { createDiscoveryQueueRuleEngine } from "./discovery-queue-rules.js";

function isVisible(element) {
  return Boolean(
    element &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden",
  );
}

function getAppId(url) {
  try {
    return new URL(url, location.href).pathname.match(/^\/app\/(\d+)(?:\/|$)/)?.[1];
  } catch {
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

export function getModalQueueAction(target) {
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
    appId: getAppId(appLink.href),
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

function getModalContext() {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')];
  for (const dialog of dialogs) {
    const queueLink = dialog.querySelector('a[href*="/explore"][href*="dq=widget"]');
    const header = queueLink?.parentElement?.parentElement;
    if (!(header instanceof HTMLElement)) {
      continue;
    }

    const dialogRect = dialog.getBoundingClientRect();
    const candidates = [...dialog.querySelectorAll("[aria-label]")]
      .map((element) => getModalQueueAction(element))
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

export function startDiscoveryQueueAutoFilter({ getStoreItem, onConfigChange } = {}) {
  const ruleEngine = createDiscoveryQueueRuleEngine({ getStoreItem });
  let stopped = false;
  let paused = false;
  let scheduled = false;
  let generation = 0;
  let evaluatedKey;
  let activeConfig;

  const configUi = createDiscoveryQueueConfigUi({
    onSave() {
      activeConfig = configUi.getConfig();
      if (typeof onConfigChange === "function") {
        onConfigChange(activeConfig);
      }
      generation += 1;
      evaluatedKey = undefined;
      schedule();
    },
    onOpenChange(open) {
      paused = open;
      if (!open) {
        schedule();
      }
    },
  });

  activeConfig = configUi.getConfig();
  if (typeof onConfigChange === "function") {
    onConfigChange(activeConfig);
  }

  function getContext() {
    return getModalContext() ?? getClassicContext();
  }

  async function evaluateCurrent() {
    scheduled = false;
    const context = getContext();
    if (!context) {
      return;
    }
    configUi.ensureButton(context.buttonHost);
    const config = activeConfig ?? configUi.getConfig();
    if (paused || !config.enabled || !context.appId || context.key === evaluatedKey) {
      return;
    }

    evaluatedKey = context.key;
    const currentGeneration = ++generation;
    const result = await ruleEngine.evaluate({
      appId: context.appId,
      reviews: context.reviews,
      tags: context.tags,
      config,
    });
    if (stopped || paused || currentGeneration !== generation || !result.matched) {
      return;
    }
    const current = getContext();
    if (current?.key === context.key && current.ignoreButton instanceof HTMLElement) {
      current.ignoreButton.click();
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
        record.target.closest('[role="dialog"], #queueActionsCtn')
      ) {
        return true;
      }
      return [...record.addedNodes].some(
        (node) =>
          node instanceof Element &&
          (node.matches('[role="dialog"], #queueActionsCtn') ||
            node.querySelector('[role="dialog"], #queueActionsCtn')),
      );
    });
    if (relevant) {
      schedule();
    }
  });
  observer.observe(document, { childList: true, subtree: true });
  schedule();

  return () => {
    stopped = true;
    generation += 1;
    observer.disconnect();
    configUi.destroy();
    ruleEngine.clear();
  };
}
