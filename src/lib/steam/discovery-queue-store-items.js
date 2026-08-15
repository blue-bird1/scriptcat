import { createDiscoveryQueueTagCatalog } from "./discovery-queue-tags.js";

const CACHE_WAIT_MS = 50;
const CHINESE_LANGUAGE_IDS = new Set([6, 7, 29]);
const DLC_APP_TYPE = 4;
const SUPPORTED_LANGUAGES_REQUEST = { include_supported_languages: true };

function getStoreItemCache() {
  const cache = window.StoreItemCache;
  return cache &&
    typeof cache.GetApp === "function" &&
    typeof cache.QueueAppRequest === "function"
    ? cache
    : undefined;
}

async function waitForStoreItemCache(logger) {
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
  logger?.warn("cache.unavailable", { waitedMs: CACHE_WAIT_MS });
  return undefined;
}

function toSafeNonNegativeInteger(value) {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function readArray(getter, logger, field, appId) {
  try {
    const value = getter();
    return Array.isArray(value)
      ? value.filter((entry) => Number.isSafeInteger(entry) && entry > 0)
      : [];
  } catch (error) {
    logger?.error("item.read.error", error, { appId, field });
    return [];
  }
}

function readSupportedLanguages(item, logger, appId) {
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
  } catch (error) {
    logger?.error("item.read.error", error, {
      appId,
      field: "supportedLanguages",
    });
    return undefined;
  }
}

function readDescriptionHasChinese(item, logger, appId) {
  if (typeof item.GetShortDescription !== "function") {
    return undefined;
  }

  try {
    const description = item.GetShortDescription();
    return typeof description === "string"
      ? /\p{Script=Han}/u.test(description)
      : undefined;
  } catch (error) {
    logger?.error("item.read.error", error, {
      appId,
      field: "descriptionHasChinese",
    });
    return undefined;
  }
}

function readAppType(item, logger, appId) {
  if (typeof item?.GetAppType !== "function") {
    return undefined;
  }

  try {
    const appType = item.GetAppType();
    return Number.isSafeInteger(appType) && appType >= 0 ? appType : undefined;
  } catch (error) {
    logger?.error("item.read.error", error, { appId, field: "appType" });
    return undefined;
  }
}

function buildStoreItemRequest(requirements, appType) {
  const request = {};
  if (requirements?.needsReviews === true) {
    request.include_reviews = true;
  }
  if (requirements?.needsReleaseDate === true) {
    request.include_release = true;
  }
  if (requirements?.needsDlc === true && appType === undefined) {
    request.include_basic_info = true;
  }

  return request;
}

function readReviewSummary(item, logger, appId) {
  const preferUnfiltered =
    window.GDynamicStore?.s_preferences?.review_score_preference === 1;
  const summaryGetter = preferUnfiltered
    ? item.GetUnfilteredReviewSummary
    : item.GetFilteredReviewSummary;

  let summary;
  try {
    summary = summaryGetter?.call(item);
  } catch (error) {
    logger?.error("item.read.error", error, {
      appId,
      field: "reviewSummary",
    });
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

function readStoreItem(item, appId, logger) {
  if (!item || typeof item !== "object") {
    return undefined;
  }

  try {
    if (typeof item.GetID === "function" && item.GetID() !== appId) {
      return undefined;
    }

    const purchase = item.GetBestPurchaseOption?.();
    const comingSoon = item.BIsComingSoon?.();
    const appType = readAppType(item, logger, appId);
    const reviews = readReviewSummary(item, logger, appId);
    const storeItem = {
      appId,
      success: 1,
      isFree: item.BIsFree?.(),
      comingSoon,
      descriptionHasChinese: readDescriptionHasChinese(item, logger, appId),
      isDlc: appType === undefined ? undefined : appType === DLC_APP_TYPE,
      supportedLanguages: readSupportedLanguages(item, logger, appId),
      tagIds: readArray(() => item.GetTagIDs?.(), logger, "tagIds", appId),
      categoryIds: {
        supportedPlayers: readArray(() => item.GetStoreCategories_SupportedPlayers?.(), logger, "supportedPlayers", appId),
        features: readArray(() => item.GetStoreCategories_Features?.(), logger, "features", appId),
        controllers: readArray(() => item.GetStoreCategories_Controller?.(), logger, "controllers", appId),
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
  } catch (error) {
    logger?.error("item.read.error", error, { appId, field: "storeItem" });
    return undefined;
  }
}

export function createDiscoveryQueueStoreItemReader({ logger } = {}) {
  const tagCatalog = createDiscoveryQueueTagCatalog({
    logger: logger?.child?.("tags") ?? logger,
  });
  let stopped = false;

  return {
    async prepareBatch(appIds, requiredLanguages) {
      if (
        stopped ||
        !Array.isArray(appIds) ||
        !Array.isArray(requiredLanguages) ||
        requiredLanguages.length === 0
      ) {
        return;
      }
      const cache = await waitForStoreItemCache(logger);
      if (
        !cache ||
        typeof cache.QueueMultipleAppRequests !== "function" ||
        stopped
      ) {
        return;
      }

      const acceptsChineseDescription = requiredLanguages.some((language) =>
        CHINESE_LANGUAGE_IDS.has(language),
      );
      const missingAppIds = appIds.filter((appId) => {
        const item = cache.GetApp(appId);
        return !(
          acceptsChineseDescription &&
          readDescriptionHasChinese(item, logger, appId) === true
        ) && !item?.BContainDataRequest?.(SUPPORTED_LANGUAGES_REQUEST);
      });
      if (missingAppIds.length === 0) {
        return;
      }
      const startedAt = performance.now();
      logger?.info("batch.request.started", {
        appIds: [...missingAppIds],
        request: SUPPORTED_LANGUAGES_REQUEST,
        requiredLanguages: [...requiredLanguages],
      });
      try {
        await cache.QueueMultipleAppRequests(
          missingAppIds,
          SUPPORTED_LANGUAGES_REQUEST,
        );
        logger?.info("batch.request.completed", {
          appIds: [...missingAppIds],
          durationMs: performance.now() - startedAt,
          requiredLanguages: [...requiredLanguages],
        });
      } catch (error) {
        logger?.error("batch.request.error", error, {
          appIds: [...missingAppIds],
          durationMs: performance.now() - startedAt,
          request: SUPPORTED_LANGUAGES_REQUEST,
          requiredLanguages: [...requiredLanguages],
        });
        return;
      }
    },
    async get(appId, requirements) {
      if (stopped || typeof appId !== "string" || !/^[1-9]\d*$/.test(appId)) {
        return undefined;
      }

      const numericAppId = Number(appId);
      if (!Number.isSafeInteger(numericAppId)) {
        return undefined;
      }

      const cache = await waitForStoreItemCache(logger);
      if (!cache || stopped) {
        return undefined;
      }

      try {
        let item = cache.GetApp(numericAppId);
        const request = buildStoreItemRequest(
          requirements,
          readAppType(item, logger, numericAppId),
        );
        if (
          Object.keys(request).length > 0 &&
          !item?.BContainDataRequest?.(request)
        ) {
          const startedAt = performance.now();
          logger?.debug("item.request.started", {
            appId: numericAppId,
            request,
            requirements,
          });
          await cache.QueueAppRequest(numericAppId, request);
          item = cache.GetApp(numericAppId);
          logger?.debug("item.request.completed", {
            appId: numericAppId,
            durationMs: performance.now() - startedAt,
            request,
            requirements,
          });
        }
        const result = readStoreItem(item, numericAppId, logger);
        logger?.debug("item.result", {
          appId: numericAppId,
          requirements,
          result,
        });
        return result;
      } catch (error) {
        logger?.error("item.request.error", error, {
          appId: numericAppId,
          requirements,
        });
        return undefined;
      }
    },
    async getLocalizedTags(appId) {
      if (stopped || typeof appId !== "string" || !/^[1-9]\d*$/.test(appId)) {
        return [];
      }

      const numericAppId = Number(appId);
      if (!Number.isSafeInteger(numericAppId)) {
        return [];
      }

      const cache = await waitForStoreItemCache(logger);
      if (!cache || stopped) {
        return [];
      }

      try {
        const tagIds = readArray(
          () => cache.GetApp(numericAppId)?.GetTagIDs?.(),
          logger,
          "tagIds",
          numericAppId,
        );
        const uniqueTagIds = [...new Set(tagIds)];
        if (uniqueTagIds.length === 0) {
          return [];
        }

        const names = await tagCatalog.getNames(uniqueTagIds);
        logger?.debug("tags.resolved", {
          appId: numericAppId,
          names,
          tagIds: uniqueTagIds,
        });
        return names;
      } catch (error) {
        logger?.error("tags.resolve.error", error, { appId: numericAppId });
        return [];
      }
    },
    stop() {
      stopped = true;
      tagCatalog.clear();
    },
  };
}
