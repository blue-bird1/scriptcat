const TAG_LIST_URL =
  "https://api.steampowered.com/IStoreService/GetTagList/v1/";
const TAG_CACHE_PREFIX = "LocalizedTagNames2_";

function readSteamLanguage(logger) {
  try {
    const config = document.querySelector("#application_config[data-config]")
      ?.dataset.config;
    const language = config ? JSON.parse(config).LANGUAGE : undefined;
    if (typeof language === "string" && language) {
      return language;
    }
  } catch (error) {
    logger?.error("language.config.error", error, {
      fallback: "window-or-html-language",
    });
  }

  if (typeof window.g_strLanguage === "string" && window.g_strLanguage) {
    return window.g_strLanguage;
  }
  const htmlLanguage = document.documentElement?.lang?.toLowerCase();
  if (htmlLanguage === "zh-cn") {
    return "schinese";
  }
  if (htmlLanguage === "zh-tw" || htmlLanguage === "zh-hk") {
    return "tchinese";
  }
  return "english";
}

function parseTags(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tags = [];
  for (const entry of value) {
    const tagId = entry?.tagid;
    const name = entry?.name;
    if (
      !Number.isSafeInteger(tagId) ||
      tagId < 1 ||
      typeof name !== "string" ||
      !name.trim()
    ) {
      return undefined;
    }
    tags.push([tagId, name.trim()]);
  }
  return tags;
}

function readCachedTags(language, logger) {
  try {
    const value = JSON.parse(
      localStorage.getItem(`${TAG_CACHE_PREFIX}${language}`) ?? "null",
    );
    const tags = parseTags(value?.tags);
    return tags ? { tags, versionHash: String(value.version_hash ?? "") } : undefined;
  } catch (error) {
    logger?.error("cache.read.error", error, { language });
    return undefined;
  }
}

function saveCachedTags(language, value, logger) {
  try {
    localStorage.setItem(
      `${TAG_CACHE_PREFIX}${language}`,
      JSON.stringify({
        tags: value.tags.map(([tagid, name]) => ({ tagid, name })),
        version_hash: value.versionHash,
      }),
    );
  } catch (error) {
    logger?.error("cache.write.error", error, {
      language,
      tagCount: value.tags.length,
    });
    return false;
  }
  return true;
}

async function loadTagNames(language, logger) {
  const cached = readCachedTags(language, logger);
  if (cached) {
    logger?.debug("catalog.cache-hit", {
      language,
      tagCount: cached.tags.length,
      versionHash: cached.versionHash,
    });
    return new Map(cached.tags);
  }

  const url = new URL(TAG_LIST_URL);
  url.searchParams.set("language", language);
  url.searchParams.set("origin", location.origin);

  const startedAt = performance.now();
  logger?.info("catalog.request.started", { language, url: url.href });
  try {
    const response = await fetch(url);
    if (!response.ok) {
      logger?.warn("catalog.request.http-error", {
        durationMs: performance.now() - startedAt,
        language,
        status: response.status,
        statusText: response.statusText,
        url: url.href,
      });
      return new Map();
    }
    const payload = (await response.json())?.response;
    const tags = parseTags(payload?.tags);
    if (tags) {
      const value = {
        tags,
        versionHash: String(payload.version_hash ?? ""),
      };
      const persisted = saveCachedTags(language, value, logger);
      logger?.info("catalog.request.completed", {
        durationMs: performance.now() - startedAt,
        language,
        persisted,
        status: response.status,
        tagCount: tags.length,
        url: url.href,
        versionHash: value.versionHash,
      });
      return new Map(tags);
    }
    logger?.warn("catalog.response.invalid", {
      durationMs: performance.now() - startedAt,
      language,
      status: response.status,
      url: url.href,
    });
  } catch (error) {
    logger?.error("catalog.request.error", error, {
      durationMs: performance.now() - startedAt,
      language,
      url: url.href,
    });
    return new Map();
  }
  return new Map();
}

export function createDiscoveryQueueTagCatalog({ logger } = {}) {
  const catalogs = new Map();

  return {
    async getNames(tagIds) {
      if (!Array.isArray(tagIds) || tagIds.length === 0) {
        return [];
      }
      const language = readSteamLanguage(logger);
      let catalogPromise = catalogs.get(language);
      if (!catalogPromise) {
        catalogPromise = loadTagNames(language, logger);
        catalogs.set(language, catalogPromise);
      }
      const catalog = await catalogPromise;
      return tagIds
        .map((tagId) => catalog.get(tagId))
        .filter((name) => typeof name === "string");
    },
    clear() {
      catalogs.clear();
    },
  };
}
