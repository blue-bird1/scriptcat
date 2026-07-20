const STORE_ITEM_REQUEST = {
  include_release: true,
  include_reviews: true,
  include_tag_count: 20,
};
const CACHE_WAIT_MS = 50;

function getStoreItemCache() {
  const cache = window.StoreItemCache;
  return cache &&
    typeof cache.GetApp === "function" &&
    typeof cache.QueueAppRequest === "function"
    ? cache
    : undefined;
}

async function waitForStoreItemCache() {
  const existing = getStoreItemCache();
  if (existing) {
    return existing;
  }

  const deadline = performance.now() + CACHE_WAIT_MS;
  while (performance.now() < deadline) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const cache = getStoreItemCache();
    if (cache) {
      return cache;
    }
  }
  return undefined;
}

function toSafeNonNegativeInteger(value) {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function readArray(getter) {
  try {
    const value = getter();
    return Array.isArray(value)
      ? value.filter((entry) => Number.isSafeInteger(entry) && entry > 0)
      : [];
  } catch {
    return [];
  }
}

function readReviewSummary(item) {
  const preferUnfiltered =
    window.GDynamicStore?.s_preferences?.review_score_preference === 1;
  const summaryGetter = preferUnfiltered
    ? item.GetUnfilteredReviewSummary
    : item.GetFilteredReviewSummary;

  let summary;
  try {
    summary = summaryGetter?.call(item);
  } catch {
    return {};
  }

  const reviewCount = toSafeNonNegativeInteger(summary?.review_count);
  const positiveRate = summary?.percent_positive;
  return {
    reviewCount,
    positiveRate:
      reviewCount !== 0 &&
      typeof positiveRate === "number" &&
      Number.isFinite(positiveRate) &&
      positiveRate >= 0 &&
      positiveRate <= 100
        ? positiveRate
        : undefined,
  };
}

function readStoreItem(item, appId) {
  if (!item || typeof item !== "object") {
    return undefined;
  }

  try {
    if (typeof item.GetID === "function" && item.GetID() !== appId) {
      return undefined;
    }

    const purchase = item.GetBestPurchaseOption?.();
    const comingSoon = item.BIsComingSoon?.();
    const reviews = readReviewSummary(item);
    const storeItem = {
      appId,
      success: 1,
      isFree: item.BIsFree?.(),
      comingSoon,
      tagIds: readArray(() => item.GetTagIDs?.()),
      categoryIds: {
        supportedPlayers: readArray(() => item.GetStoreCategories_SupportedPlayers?.()),
        features: readArray(() => item.GetStoreCategories_Features?.()),
        controllers: readArray(() => item.GetStoreCategories_Controller?.()),
      },
      ...reviews,
    };

    if (comingSoon === false) {
      storeItem.releaseDateUnix = toSafeNonNegativeInteger(item.GetReleaseDateRTime?.(true));
    }
    if (purchase && typeof purchase === "object") {
      storeItem.finalPriceInCents = toSafeNonNegativeInteger(purchase.final_price_in_cents);
      storeItem.originalPriceInCents = toSafeNonNegativeInteger(purchase.original_price_in_cents);
      storeItem.formattedFinalPrice = purchase.formatted_final_price;
      storeItem.formattedOriginalPrice = purchase.formatted_original_price;
      storeItem.discount = toSafeNonNegativeInteger(purchase.discount_pct);
    }
    return storeItem;
  } catch {
    return undefined;
  }
}

export function createDiscoveryQueueStoreItemReader() {
  let stopped = false;

  return {
    async get(appId) {
      if (stopped || typeof appId !== "string" || !/^[1-9]\d*$/.test(appId)) {
        return undefined;
      }

      const numericAppId = Number(appId);
      if (!Number.isSafeInteger(numericAppId)) {
        return undefined;
      }

      const cache = await waitForStoreItemCache();
      if (!cache || stopped) {
        return undefined;
      }

      try {
        let item = cache.GetApp(numericAppId);
        if (!item?.BContainDataRequest?.(STORE_ITEM_REQUEST)) {
          await cache.QueueAppRequest(numericAppId, STORE_ITEM_REQUEST);
          item = cache.GetApp(numericAppId);
        }
        return readStoreItem(item, numericAppId);
      } catch {
        return undefined;
      }
    },
    stop() {
      stopped = true;
    },
  };
}
