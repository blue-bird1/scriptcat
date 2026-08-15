import { createProfileFeaturesLimitedReader } from "./discovery-queue-profile-features.js";

const MONTHS = new Map([
  ["jan", 0],
  ["feb", 1],
  ["mar", 2],
  ["apr", 3],
  ["may", 4],
  ["jun", 5],
  ["jul", 6],
  ["aug", 7],
  ["sep", 8],
  ["oct", 9],
  ["nov", 10],
  ["dec", 11],
]);

function createEmptyData() {
  return {
    reviewCount: undefined,
    positiveRate: undefined,
    isDlc: undefined,
    profileFeaturesLimited: undefined,
    isFree: undefined,
    price: undefined,
    currency: undefined,
    discount: undefined,
    releaseDate: undefined,
    descriptionHasChinese: undefined,
    supportedLanguages: undefined,
  };
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseEnglishDate(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const match = value.trim().match(/^(?:(?<month>[A-Za-z]+)\s+(?<day>\d{1,2})|(?<dayFirst>\d{1,2})\s+(?<monthFirst>[A-Za-z]+)),\s*(?<year>\d{4})$/);
  if (!match?.groups) {
    return undefined;
  }

  const monthName = (match.groups.month ?? match.groups.monthFirst).slice(0, 3).toLowerCase();
  const month = MONTHS.get(monthName);
  const day = Number(match.groups.day ?? match.groups.dayFirst);
  const year = Number(match.groups.year);
  const date = new Date(Date.UTC(year, month ?? -1, day));
  if (
    month === undefined ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return `${year.toString().padStart(4, "0")}-${(month + 1).toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

function parseReviews(payload) {
  const summary = payload?.query_summary;
  if (
    !isNonNegativeInteger(summary?.total_positive) ||
    !isNonNegativeInteger(summary?.total_negative) ||
    !isNonNegativeInteger(summary?.total_reviews)
  ) {
    return {};
  }

  return {
    reviewCount: summary.total_reviews,
    positiveRate: summary.total_reviews === 0 ? undefined : (summary.total_positive / summary.total_reviews) * 100,
  };
}

function parseDetails(payload, appId) {
  const details = payload?.[appId];
  if (details?.success !== true || !details.data || typeof details.data !== "object") {
    return {};
  }

  const result = {};
  if (typeof details.data.is_free === "boolean") {
    result.isFree = details.data.is_free;
  }

  const priceOverview = details.data.price_overview;
  if (
    isNonNegativeInteger(priceOverview?.final) &&
    typeof priceOverview.currency === "string" &&
    priceOverview.currency.trim()
  ) {
    try {
      const currency = priceOverview.currency.trim().toUpperCase();
      const formatter = new Intl.NumberFormat("en", { style: "currency", currency });
      const fractionDigits = formatter.resolvedOptions().maximumFractionDigits;
      result.price = priceOverview.final / 10 ** fractionDigits;
      result.currency = currency;
      if (isNonNegativeInteger(priceOverview.discount_percent)) {
        result.discount = priceOverview.discount_percent;
      }
    } catch {
      result.price = undefined;
    }
  }

  if (details.data.release_date?.coming_soon !== true) {
    result.releaseDate = parseEnglishDate(details.data.release_date?.date);
  }

  const type =
    typeof details.data.type === "string"
      ? details.data.type.trim().toLowerCase()
      : "";
  if (type) {
    result.isDlc = type === "dlc";
  }

  return result;
}

function parseStoreItemPrice(formattedPrice, priceInCents) {
  if (typeof formattedPrice !== "string" || !isNonNegativeInteger(priceInCents)) {
    return undefined;
  }

  const numericParts = formattedPrice.match(/\d[\d\s.,\u00A0\u202F]*/g);
  if (numericParts?.length !== 1) {
    return undefined;
  }

  const numericText = numericParts[0].trim();
  if (!numericText || /[.,\s\u00A0\u202F]$/.test(numericText)) {
    return undefined;
  }

  const digits = numericText.replace(/[^\d]/g, "");
  if (!digits) {
    return undefined;
  }

  const integerPrice = Number(digits);
  const candidatesInCents = Number.isSafeInteger(integerPrice)
    ? [integerPrice * 100]
    : [];
  const decimalMatch = numericText.match(/[.,](\d{1,2})$/);
  if (decimalMatch) {
    const fractionalDigits = decimalMatch[1].length;
    const integerDigits = numericText.slice(0, -fractionalDigits - 1).replace(/[^\d]/g, "");
    if (integerDigits) {
      const integerPart = Number(integerDigits);
      const fractionalPart = Number(decimalMatch[1]) * 10 ** (2 - fractionalDigits);
      if (Number.isSafeInteger(integerPart) && Number.isSafeInteger(fractionalPart)) {
        candidatesInCents.push(integerPart * 100 + fractionalPart);
      }
    }
  }

  return candidatesInCents.includes(priceInCents) ? priceInCents / 100 : undefined;
}

function parseStoreItem(storeItem, appId) {
  if (
    !storeItem ||
    typeof storeItem !== "object" ||
    storeItem.success !== 1 ||
    String(storeItem.appId) !== appId
  ) {
    return {};
  }

  const result = {};
  if (typeof storeItem.descriptionHasChinese === "boolean") {
    result.descriptionHasChinese = storeItem.descriptionHasChinese;
  }
  if (Array.isArray(storeItem.supportedLanguages)) {
    result.supportedLanguages = [
      ...new Set(
        storeItem.supportedLanguages.filter(
          (language) => Number.isSafeInteger(language) && language >= 0,
        ),
      ),
    ];
  }
  if (isNonNegativeInteger(storeItem.reviewCount)) {
    result.reviewCount = storeItem.reviewCount;
  }
  if (
    typeof storeItem.positiveRate === "number" &&
    Number.isFinite(storeItem.positiveRate) &&
    storeItem.positiveRate >= 0 &&
    storeItem.positiveRate <= 100
  ) {
    result.positiveRate = storeItem.positiveRate;
  }
  if (typeof storeItem.isFree === "boolean") {
    result.isFree = storeItem.isFree;
    if (storeItem.isFree) {
      result.price = 0;
    }
  }
  if (typeof storeItem.isDlc === "boolean") {
    result.isDlc = storeItem.isDlc;
  }
  if (storeItem.comingSoon === false && Number.isSafeInteger(storeItem.releaseDateUnix) && storeItem.releaseDateUnix > 0) {
    const date = new Date(storeItem.releaseDateUnix * 1000);
    if (!Number.isNaN(date.getTime())) {
      result.releaseDate = date.toISOString().slice(0, 10);
    }
  }
  if (Number.isInteger(storeItem.discount) && storeItem.discount >= 0 && storeItem.discount <= 100) {
    result.discount = storeItem.discount;
  }

  if (result.price === undefined) {
    const price = parseStoreItemPrice(storeItem.formattedFinalPrice, storeItem.finalPriceInCents);
    if (price !== undefined) {
      result.price = price;
    }
  }
  return result;
}

async function loadJson(url, logger, source, appId) {
  const startedAt = performance.now();
  logger?.debug("request.started", { appId, source, url });
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const diagnostic = {
        kind: "http",
        status: response.status,
        statusText: response.statusText,
      };
      logger?.warn("request.http-error", {
        appId,
        durationMs: performance.now() - startedAt,
        source,
        url,
        ...diagnostic,
      });
      return { diagnostic, payload: undefined };
    }
    const payload = await response.json();
    logger?.debug("request.completed", {
      appId,
      durationMs: performance.now() - startedAt,
      source,
      status: response.status,
      url,
    });
    return { diagnostic: undefined, payload };
  } catch (error) {
    logger?.error("request.error", error, {
      appId,
      durationMs: performance.now() - startedAt,
      source,
      url,
    });
    return { diagnostic: { error, kind: "exception" }, payload: undefined };
  }
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }

  return [...new Set(tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function isEnabledNumber(rule) {
  return rule?.enabled === true && typeof rule.value === "number" && Number.isFinite(rule.value);
}

function getRequiredLanguages(rule) {
  return rule?.enabled === true && Array.isArray(rule.value)
    ? [
        ...new Set(
          rule.value.filter(
            (language) => Number.isSafeInteger(language) && language >= 0,
          ),
        ),
      ]
    : [];
}

function hasRequiredChineseLanguage(requiredLanguages) {
  return (
    requiredLanguages.includes(6) ||
    requiredLanguages.includes(7) ||
    requiredLanguages.includes(29)
  );
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function getUnresolved(requirements, data, profileFeaturesChecked) {
  const unresolved = [];
  const requiredFields = [
    [requirements.needsPositiveRate, "positiveRate"],
    [requirements.needsReviewCount, "reviewCount"],
    [requirements.needsPrice, "price"],
    [requirements.needsDiscount, "discount"],
    [requirements.needsReleaseDate, "releaseDate"],
    [requirements.needsFreeStatus, "isFree"],
    [requirements.needsDlc, "isDlc"],
  ];
  for (const [required, field] of requiredFields) {
    if (required && data[field] === undefined) {
      unresolved.push(field);
    }
  }
  if (
    requirements.needsSupportedLanguages &&
    data.descriptionHasChinese !== true &&
    data.supportedLanguages === undefined
  ) {
    unresolved.push("supportedLanguages");
  }
  if (profileFeaturesChecked && data.profileFeaturesLimited === undefined) {
    unresolved.push("profileFeaturesLimited");
  }
  return unresolved;
}

export function createDiscoveryQueueRuleEngine({ getStoreItem, logger } = {}) {
  const reviewsCache = new Map();
  const detailsCache = new Map();
  const profileFeaturesLimitedReader = createProfileFeaturesLimitedReader({
    logger: logger?.child?.("profile-features") ?? logger,
  });

  function loadCached(cache, appId, url, source) {
    let payloadPromise = cache.get(appId);
    if (!payloadPromise) {
      payloadPromise = loadJson(url, logger, source, appId);
      cache.set(appId, payloadPromise);
      payloadPromise.then((result) => {
        if (result.payload === undefined && cache.get(appId) === payloadPromise) {
          cache.delete(appId);
        }
      });
    }
    return payloadPromise;
  }

  async function loadStoreItem(appId, requirements) {
    if (typeof getStoreItem !== "function") {
      return {
        data: {},
        diagnostic: { kind: "unavailable", reason: "reader-missing" },
      };
    }

    try {
      return {
        data: parseStoreItem(await getStoreItem(appId, requirements), appId),
        diagnostic: undefined,
      };
    } catch (error) {
      logger?.error("store-item.error", error, { appId, requirements });
      return { data: {}, diagnostic: { error, kind: "exception" } };
    }
  }

  return {
    async evaluate({ appId, reviews: existingReviews, tags, config }) {
      if (!/^[1-9]\d*$/.test(appId)) {
        throw new TypeError("appId must be a positive integer string");
      }
      if (config?.enabled === false) {
        const result = { matched: false, reasons: [], data: createEmptyData() };
        logger?.info("evaluation.completed", {
          appId,
          config,
          data: result.data,
          matched: false,
          reasons: [],
          requirements: { enabled: false },
          sourceErrors: [],
          unresolved: [],
        });
        return result;
      }

      const needsPositiveRate = isEnabledNumber(config?.minimumPositiveRate);
      const needsReviewCount =
        isEnabledNumber(config?.minimumReviewCount) || config?.ignoreUnreviewed === true;
      const needsReviews =
        (needsPositiveRate && existingReviews?.positiveRate === undefined) ||
        (needsReviewCount && existingReviews?.reviewCount === undefined);
      const needsPrice = isEnabledNumber(config?.maximumPrice);
      const needsDiscount = isEnabledNumber(config?.minimumDiscount);
      const needsReleaseDate = config?.earliestReleaseDate?.enabled === true && isIsoDate(config.earliestReleaseDate.value);
      const needsFreeStatus = config?.ignoreFree === true;
      const needsDlc = config?.ignoreDlc === true;
      const needsDetails = needsPrice || needsDiscount || needsReleaseDate || needsFreeStatus || needsDlc;
      const requiredLanguages = getRequiredLanguages(config?.requiredLanguages);
      const needsSupportedLanguages = requiredLanguages.length > 0;

      const requirements = {
        needsDetails,
        needsDiscount,
        needsDlc,
        needsFreeStatus,
        needsPositiveRate,
        needsPrice,
        needsReleaseDate,
        needsReviewCount,
        needsReviews,
        needsSupportedLanguages,
        requiredLanguages,
      };
      const storeItemResult =
        needsReviews || needsDetails || needsSupportedLanguages
          ? await loadStoreItem(appId, {
              needsReviews,
              needsReleaseDate,
              needsDlc,
              requiredLanguages,
            })
          : { data: {}, diagnostic: undefined };
      const storeItem = storeItemResult.data;
      const missingStoreItemReviews =
        (needsPositiveRate && storeItem.positiveRate === undefined) ||
        (needsReviewCount && storeItem.reviewCount === undefined);
      const reviewsPromise = missingStoreItemReviews
        ? loadCached(
            reviewsCache,
            appId,
            `/appreviews/${appId}?json=1&language=all&purchase_type=steam&num_per_page=0`,
            "reviews",
          )
        : Promise.resolve({ diagnostic: undefined, payload: undefined });
      if (missingStoreItemReviews) {
        logger?.info("fallback.selected", {
          appId,
          missing: [
            needsPositiveRate && storeItem.positiveRate === undefined
              ? "positiveRate"
              : undefined,
            needsReviewCount && storeItem.reviewCount === undefined
              ? "reviewCount"
              : undefined,
          ].filter(Boolean),
          source: "reviews",
        });
      }
      const missingStoreItemData =
        (needsPrice && storeItem.price === undefined) ||
        (needsDiscount && storeItem.discount === undefined) ||
        (needsReleaseDate && storeItem.releaseDate === undefined) ||
        (needsFreeStatus && storeItem.isFree === undefined) ||
        (needsDlc && storeItem.isDlc === undefined);
      const detailsPromise = missingStoreItemData
        ? loadCached(
            detailsCache,
            appId,
            `/api/appdetails?appids=${appId}&l=english`,
            "details",
          )
        : Promise.resolve({ diagnostic: undefined, payload: undefined });
      if (missingStoreItemData) {
        logger?.info("fallback.selected", {
          appId,
          missing: [
            needsPrice && storeItem.price === undefined ? "price" : undefined,
            needsDiscount && storeItem.discount === undefined ? "discount" : undefined,
            needsReleaseDate && storeItem.releaseDate === undefined
              ? "releaseDate"
              : undefined,
            needsFreeStatus && storeItem.isFree === undefined ? "isFree" : undefined,
            needsDlc && storeItem.isDlc === undefined ? "isDlc" : undefined,
          ].filter(Boolean),
          source: "details",
        });
      }
      const [reviewsResult, detailsResult] = await Promise.all([reviewsPromise, detailsPromise]);
      const reviews = parseReviews(reviewsResult.payload);
      const details = parseDetails(detailsResult.payload, appId);
      const data = {
        ...createEmptyData(),
        ...reviews,
        ...details,
        ...storeItem,
        ...existingReviews,
      };
      const descriptionMatchesRequiredLanguage =
        data.descriptionHasChinese === true &&
        hasRequiredChineseLanguage(requiredLanguages);
      const reasons = [];
      if (isEnabledNumber(config?.minimumPositiveRate) && data.positiveRate !== undefined && data.positiveRate < config.minimumPositiveRate.value) {
        reasons.push("positive-rate");
      }
      if (isEnabledNumber(config?.minimumReviewCount) && data.reviewCount !== undefined && data.reviewCount < config.minimumReviewCount.value) {
        reasons.push("review-count");
      }
      if (isEnabledNumber(config?.maximumPrice) && data.price !== undefined && data.price > config.maximumPrice.value) {
        reasons.push("price");
      }
      if (isEnabledNumber(config?.minimumDiscount) && data.discount !== undefined && data.discount < config.minimumDiscount.value) {
        reasons.push("discount");
      }
      if (
        config?.earliestReleaseDate?.enabled === true &&
        isIsoDate(config.earliestReleaseDate.value) &&
        data.releaseDate !== undefined &&
        data.releaseDate < config.earliestReleaseDate.value
      ) {
        reasons.push("release-date");
      }
      if (config?.ignoreFree === true && data.isFree === true) {
        reasons.push("free");
      }
      if (config?.ignoreUnreviewed === true && data.reviewCount === 0) {
        reasons.push("unreviewed");
      }
      if (config?.ignoreDlc === true && data.isDlc === true) {
        reasons.push("dlc");
      }
      if (
        needsSupportedLanguages &&
        !descriptionMatchesRequiredLanguage &&
        Array.isArray(data.supportedLanguages) &&
        !requiredLanguages.some((language) =>
          data.supportedLanguages.includes(language),
        )
      ) {
        reasons.push("required-language");
      }
      if (config?.excludedTags?.enabled === true) {
        const excludedTags = new Set(normalizeTags(config.excludedTags.value));
        const matchingTags = normalizeTags(tags).filter((tag) => excludedTags.has(tag)).sort();
        reasons.push(...matchingTags.map((tag) => `tag:${tag}`));
      }

      if (reasons.length > 0 || config?.ignoreProfileFeaturesLimited !== true) {
        const result = { matched: reasons.length > 0, reasons, data };
        const sourceErrors = [
          ["store-item", storeItemResult.diagnostic],
          ["reviews", reviewsResult.diagnostic],
          ["details", detailsResult.diagnostic],
        ].filter(([, diagnostic]) => diagnostic !== undefined).map(([source, diagnostic]) => ({ source, ...diagnostic }));
        logger?.info("evaluation.completed", {
          appId,
          config,
          data,
          matched: result.matched,
          reasons: [...reasons],
          requirements,
          sourceErrors,
          unresolved: getUnresolved(requirements, data, false),
        });
        return result;
      }

      const profileFeaturesLimited =
        await profileFeaturesLimitedReader.get(appId);
      const profileDiagnostic =
        profileFeaturesLimitedReader.getDiagnostic(appId);
      if (typeof profileFeaturesLimited === "boolean") {
        data.profileFeaturesLimited = profileFeaturesLimited;
      }
      if (profileFeaturesLimited === true) {
        reasons.push("profile-features-limited");
      }

      const result = { matched: reasons.length > 0, reasons, data };
      const sourceErrors = [
        ["store-item", storeItemResult.diagnostic],
        ["reviews", reviewsResult.diagnostic],
        ["details", detailsResult.diagnostic],
        ["profile-features", profileDiagnostic],
      ].filter(([, diagnostic]) => diagnostic !== undefined).map(([source, diagnostic]) => ({ source, ...diagnostic }));
      logger?.info("evaluation.completed", {
        appId,
        config,
        data,
        matched: result.matched,
        reasons: [...reasons],
        requirements,
        sourceErrors,
        unresolved: getUnresolved(requirements, data, true),
      });
      return result;
    },
    clear() {
      reviewsCache.clear();
      detailsCache.clear();
      profileFeaturesLimitedReader.clear();
    },
  };
}
