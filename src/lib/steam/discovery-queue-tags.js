const TAG_LIST_URL =
  "https://api.steampowered.com/IStoreService/GetTagList/v1/";
const TAG_CACHE_PREFIX = "LocalizedTagNames2_";

function readSteamLanguage() {
  try {
    const config = document.querySelector("#application_config[data-config]")
      ?.dataset.config;
    const language = config ? JSON.parse(config).LANGUAGE : undefined;
    if (typeof language === "string" && language) {
      return language;
    }
  } catch (error) {
    console.warn("[Steam 探索队列] 页面语言配置不可解析，改用页面 HTML 语言", error);
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

function readCachedTags(language) {
  try {
    const value = JSON.parse(
      localStorage.getItem(`${TAG_CACHE_PREFIX}${language}`) ?? "null",
    );
    const tags = parseTags(value?.tags);
    return tags ? { tags, versionHash: String(value.version_hash ?? "") } : undefined;
  } catch (error) {
    console.warn(`[Steam 探索队列] 本地 ${language} 标签目录损坏，将重新获取`, error);
    return undefined;
  }
}

function saveCachedTags(language, value) {
  try {
    localStorage.setItem(
      `${TAG_CACHE_PREFIX}${language}`,
      JSON.stringify({
        tags: value.tags.map(([tagid, name]) => ({ tagid, name })),
        version_hash: value.versionHash,
      }),
    );
  } catch (error) {
    console.warn(`[Steam 探索队列] 无法保存 ${language} 标签目录到 Steam 本地缓存`, error);
    return false;
  }
  return true;
}

async function loadTagNames(language) {
  const cached = readCachedTags(language);
  if (cached) {
    return new Map(cached.tags);
  }

  const url = new URL(TAG_LIST_URL);
  url.searchParams.set("language", language);
  url.searchParams.set("origin", location.origin);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(
        `[Steam 探索队列] 获取 ${language} 标签目录失败：HTTP ${response.status} ${response.statusText}`.trim(),
      );
      return new Map();
    }
    const payload = (await response.json())?.response;
    const tags = parseTags(payload?.tags);
    if (tags) {
      const value = {
        tags,
        versionHash: String(payload.version_hash ?? ""),
      };
      saveCachedTags(language, value);
      return new Map(tags);
    }
    console.warn(`[Steam 探索队列] Steam 返回的 ${language} 标签目录格式无效`);
  } catch (error) {
    console.error(`[Steam 探索队列] 请求或解析 ${language} 标签目录时出错`, error);
    return new Map();
  }
  return new Map();
}

export function createDiscoveryQueueTagCatalog() {
  const catalogs = new Map();

  return {
    async getNames(tagIds) {
      if (!Array.isArray(tagIds) || tagIds.length === 0) {
        return [];
      }
      const language = readSteamLanguage();
      let catalogPromise = catalogs.get(language);
      if (!catalogPromise) {
        catalogPromise = loadTagNames(language);
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
