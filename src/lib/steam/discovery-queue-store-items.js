const CACHE_WAIT_MS = 50;
const CHINESE_LANGUAGE_IDS = new Set([6, 7, 29]);

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

function readSupportedLanguages(item) {
  if (typeof item.GetAllLanguagesWithSomeSupport !== "function") {
    return undefined;
  }

  try {
    const languages = item.GetAllLanguagesWithSomeSupport();
    return Array.isArray(languages)
      ? [
          ...new Set(
            languages.filter(
              (language) => Number.isSafeInteger(language) && language >= 0,
            ),
          ),
        ]
      : undefined;
  } catch {
    return undefined;
  }
}

function readDescriptionHasChinese(item) {
  if (typeof item.GetShortDescription !== "function") {
    return undefined;
  }

  try {
    const description = item.GetShortDescription();
    return typeof description === "string"
      ? /\p{Script=Han}/u.test(description)
      : undefined;
  } catch {
    return undefined;
  }
}

function readBooleanValue(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value === 1 || value === 0 ? value === 1 : Boolean(value);
  }
  return undefined;
}

function readBooleanField(item, names) {
  for (const name of names) {
    const value = item?.[name];
    try {
      const direct = readBooleanValue(value);
      if (direct !== undefined) {
        return direct;
      }
      if (typeof value === "function") {
        return readBooleanValue(value.call(item));
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function readStoreItemDlc(item) {
  const candidates = [
    "GetIsDlc",
    "GetIsDLC",
    "BIsDLC",
    "BIsDlc",
    "IsDLC",
    "IsDlc",
    "GetFullGame",
    "BGetFullGame",
    "GetFullGameAppID",
    "IsDLCContent",
  ];
  const directValues = [
    "isDlc",
    "isDLC",
    "isDlcContent",
    "isDLCContent",
    "fullgame",
  ];

  const result = readBooleanField(item, candidates);
  if (result !== undefined) {
    return result;
  }

  for (const field of directValues) {
    const value = item?.[field];
    if (typeof value === "object" && value !== null) {
      if (
        toSafeNonNegativeInteger(value.appid) !== undefined ||
        toSafeNonNegativeInteger(value.id) !== undefined
      ) {
        return true;
      }
    }
    const fromField = readBooleanValue(value);
    if (fromField !== undefined) {
      return fromField;
    }
  }
  return undefined;
}

function buildStoreItemRequest(requirements, descriptionHasChinese) {
  const request = {};
  if (requirements?.needsReviews === true) {
    request.include_reviews = true;
  }
  if (requirements?.needsReleaseDate === true) {
    request.include_release = true;
  }

  const requiredLanguages = Array.isArray(requirements?.requiredLanguages)
    ? requirements.requiredLanguages
    : [];
  const acceptsChineseDescription = requiredLanguages.some((language) =>
    CHINESE_LANGUAGE_IDS.has(language),
  );
  if (requiredLanguages.length > 0 && !(acceptsChineseDescription && descriptionHasChinese)) {
    request.include_supported_languages = true;
  }
  return request;
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
      descriptionHasChinese: readDescriptionHasChinese(item),
      isDlc: readStoreItemDlc(item),
      supportedLanguages: readSupportedLanguages(item),
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
    async get(appId, requirements) {
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
        const request = buildStoreItemRequest(
          requirements,
          readDescriptionHasChinese(item),
        );
        if (
          Object.keys(request).length > 0 &&
          !item?.BContainDataRequest?.(request)
        ) {
          await cache.QueueAppRequest(numericAppId, request);
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
