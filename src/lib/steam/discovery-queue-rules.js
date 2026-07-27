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

async function loadJson(url) {
  try {
    const response = await fetch(url);
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
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

export function createDiscoveryQueueRuleEngine({ getStoreItem } = {}) {
  const reviewsCache = new Map();
  const detailsCache = new Map();

  function loadCached(cache, appId, url) {
    let payloadPromise = cache.get(appId);
    if (!payloadPromise) {
      payloadPromise = loadJson(url);
      cache.set(appId, payloadPromise);
      payloadPromise.then((payload) => {
        if (payload === undefined && cache.get(appId) === payloadPromise) {
          cache.delete(appId);
        }
      });
    }
    return payloadPromise;
  }

  async function loadStoreItem(appId, requirements) {
    if (typeof getStoreItem !== "function") {
      return {};
    }

    try {
      return parseStoreItem(await getStoreItem(appId, requirements), appId);
    } catch {
      return {};
    }
  }

  return {
    async evaluate({ appId, reviews: existingReviews, tags, config }) {
      if (!/^[1-9]\d*$/.test(appId)) {
        throw new TypeError("appId must be a positive integer string");
      }
      if (config?.enabled === false) {
        return { matched: false, reasons: [], data: createEmptyData() };
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

      const storeItem =
        needsReviews || needsDetails || needsSupportedLanguages
          ? await loadStoreItem(appId, {
              needsReviews,
              needsReleaseDate,
              needsDlc,
              requiredLanguages,
            })
          : {};
      const missingStoreItemReviews =
        (needsPositiveRate && storeItem.positiveRate === undefined) ||
        (needsReviewCount && storeItem.reviewCount === undefined);
      const reviewsPromise = missingStoreItemReviews
        ? loadCached(reviewsCache, appId, `/appreviews/${appId}?json=1&language=all&purchase_type=steam&num_per_page=0`).then(parseReviews)
        : Promise.resolve({});
      const missingStoreItemData =
        (needsPrice && storeItem.price === undefined) ||
        (needsDiscount && storeItem.discount === undefined) ||
        (needsReleaseDate && storeItem.releaseDate === undefined) ||
        (needsFreeStatus && storeItem.isFree === undefined) ||
        (needsDlc && storeItem.isDlc === undefined);
      const detailsPromise = missingStoreItemData
        ? loadCached(detailsCache, appId, `/api/appdetails?appids=${appId}&l=english`).then((payload) => parseDetails(payload, appId))
        : Promise.resolve({});
      const [reviews, details] = await Promise.all([reviewsPromise, detailsPromise]);
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

      return { matched: reasons.length > 0, reasons, data };
    },
    clear() {
      reviewsCache.clear();
      detailsCache.clear();
    },
  };
}
