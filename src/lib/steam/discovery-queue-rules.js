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
    isFree: undefined,
    price: undefined,
    currency: undefined,
    discount: undefined,
    releaseDate: undefined,
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

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function createDiscoveryQueueRuleEngine() {
  const cache = new Map();

  function load(appId) {
    let dataPromise = cache.get(appId);
    if (!dataPromise) {
      let shouldRetry = false;
      dataPromise = Promise.all([
        loadJson(`/appreviews/${appId}?json=1&language=all&purchase_type=steam&num_per_page=0`),
        loadJson(`/api/appdetails?appids=${appId}&l=english`),
      ]).then(([reviewsPayload, detailsPayload]) => {
        shouldRetry = reviewsPayload === undefined || detailsPayload === undefined;
        return {
          ...createEmptyData(),
          ...parseReviews(reviewsPayload),
          ...parseDetails(detailsPayload, appId),
        };
      });
      cache.set(appId, dataPromise);
      dataPromise.then(() => {
        if (shouldRetry && cache.get(appId) === dataPromise) {
          cache.delete(appId);
        }
      });
    }
    return dataPromise;
  }

  return {
    async evaluate({ appId, tags, config }) {
      if (!/^[1-9]\d*$/.test(appId)) {
        throw new TypeError("appId must be a positive integer string");
      }
      if (config?.enabled === false) {
        return { matched: false, reasons: [], data: createEmptyData() };
      }

      const data = await load(appId);
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
      if (config?.excludedTags?.enabled === true) {
        const excludedTags = new Set(normalizeTags(config.excludedTags.value));
        const matchingTags = normalizeTags(tags).filter((tag) => excludedTags.has(tag)).sort();
        reasons.push(...matchingTags.map((tag) => `tag:${tag}`));
      }

      return { matched: reasons.length > 0, reasons, data };
    },
    clear() {
      cache.clear();
    },
  };
}
