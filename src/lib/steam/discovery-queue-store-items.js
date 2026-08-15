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

function readArray(getter, appId, fieldName) {
  try {
    const value = getter();
    return Array.isArray(value)
      ? value.filter((entry) => Number.isSafeInteger(entry) && entry > 0)
      : [];
  } catch (error) {
    console.error(`[Steam 探索队列] 读取 App ${appId} 的${fieldName}时出错`, error);
    return [];
  }
}

function readSupportedLanguages(item, appId) {
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
    console.error(`[Steam 探索队列] 读取 App ${appId} 的支持语言时出错`, error);
    return undefined;
  }
}

function readDescriptionHasChinese(item, appId) {
  if (typeof item.GetShortDescription !== "function") {
    return undefined;
  }

  try {
    const description = item.GetShortDescription();
    return typeof description === "string"
      ? /\p{Script=Han}/u.test(description)
      : undefined;
  } catch (error) {
    console.error(`[Steam 探索队列] 读取 App ${appId} 的商店简介时出错`, error);
    return undefined;
  }
}

function readAppType(item, appId) {
  if (typeof item?.GetAppType !== "function") {
    return undefined;
  }

  try {
    const appType = item.GetAppType();
    return Number.isSafeInteger(appType) && appType >= 0 ? appType : undefined;
  } catch (error) {
    console.error(`[Steam 探索队列] 读取 App ${appId} 的应用类型时出错`, error);
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

function readReviewSummary(item, appId) {
  const preferUnfiltered =
    window.GDynamicStore?.s_preferences?.review_score_preference === 1;
  const summaryGetter = preferUnfiltered
    ? item.GetUnfilteredReviewSummary
    : item.GetFilteredReviewSummary;

  let summary;
  try {
    summary = summaryGetter?.call(item);
  } catch (error) {
    console.error(`[Steam 探索队列] 读取 App ${appId} 的评测摘要时出错`, error);
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
    const appType = readAppType(item, appId);
    const reviews = readReviewSummary(item, appId);
    const storeItem = {
      appId,
      success: 1,
      isFree: item.BIsFree?.(),
      comingSoon,
      descriptionHasChinese: readDescriptionHasChinese(item, appId),
      isDlc: appType === undefined ? undefined : appType === DLC_APP_TYPE,
      supportedLanguages: readSupportedLanguages(item, appId),
      tagIds: readArray(() => item.GetTagIDs?.(), appId, "标签"),
      categoryIds: {
        supportedPlayers: readArray(
          () => item.GetStoreCategories_SupportedPlayers?.(),
          appId,
          "玩家模式分类",
        ),
        features: readArray(
          () => item.GetStoreCategories_Features?.(),
          appId,
          "功能分类",
        ),
        controllers: readArray(
          () => item.GetStoreCategories_Controller?.(),
          appId,
          "控制器分类",
        ),
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
    console.error(`[Steam 探索队列] 读取 App ${appId} 的 Steam 商店缓存时出错`, error);
    return undefined;
  }
}

export function createDiscoveryQueueStoreItemReader() {
  const tagCatalog = createDiscoveryQueueTagCatalog();
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
      const cache = await waitForStoreItemCache();
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
      let missingAppIds;
      try {
        missingAppIds = appIds.filter((appId) => {
          const item = cache.GetApp(appId);
          return !(
            acceptsChineseDescription &&
            readDescriptionHasChinese(item, appId) === true
          ) && !item?.BContainDataRequest?.(SUPPORTED_LANGUAGES_REQUEST);
        });
      } catch (error) {
        console.error("[Steam 探索队列] 检查本批支持语言缓存时出错", error);
        return;
      }
      if (missingAppIds.length === 0) {
        return;
      }
      try {
        await cache.QueueMultipleAppRequests(
          missingAppIds,
          SUPPORTED_LANGUAGES_REQUEST,
        );
      } catch (error) {
        console.error(
          `[Steam 探索队列] 批量补齐 ${missingAppIds.length} 个 App 的支持语言时出错`,
          error,
        );
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

      const cache = await waitForStoreItemCache();
      if (!cache || stopped) {
        return undefined;
      }

      try {
        let item = cache.GetApp(numericAppId);
        const request = buildStoreItemRequest(
          requirements,
          readAppType(item, numericAppId),
        );
        if (
          Object.keys(request).length > 0 &&
          !item?.BContainDataRequest?.(request)
        ) {
          await cache.QueueAppRequest(numericAppId, request);
          item = cache.GetApp(numericAppId);
        }
        return readStoreItem(item, numericAppId);
      } catch (error) {
        console.error(`[Steam 探索队列] 请求或读取 App ${appId} 的 Steam 商店数据时出错`, error);
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

      const cache = await waitForStoreItemCache();
      if (!cache || stopped) {
        return [];
      }

      try {
        const tagIds = readArray(
          () => cache.GetApp(numericAppId)?.GetTagIDs?.(),
          numericAppId,
          "标签",
        );
        const uniqueTagIds = [...new Set(tagIds)];
        if (uniqueTagIds.length === 0) {
          return [];
        }

        return await tagCatalog.getNames(uniqueTagIds);
      } catch (error) {
        console.error(`[Steam 探索队列] 读取 App ${appId} 的本地化标签时出错`, error);
        return [];
      }
    },
    stop() {
      stopped = true;
      tagCatalog.clear();
    },
  };
}
