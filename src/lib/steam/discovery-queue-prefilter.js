import { loadDiscoveryQueueConfig } from "./discovery-queue-config.js";
import { createDiscoveryQueueRuleEngine } from "./discovery-queue-rules.js";

const DISCOVERY_QUEUE_URL =
  "https://api.steampowered.com/IStoreService/GetDiscoveryQueue/v1/";
const PERMIT_DURATION_MS = 10_000;
const PREFILTER_CONCURRENCY = 4;
const POLL_INTERVAL_MS = 50;

function readVarint(bytes, offset) {
  let value = 0;
  let shift = 0;
  for (let index = 0; index < 10; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined) {
      return undefined;
    }
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) {
      return Number.isSafeInteger(value)
        ? { value, offset: offset + index + 1 }
        : undefined;
    }
    shift += 7;
  }
  return undefined;
}

function skipField(bytes, wireType, offset) {
  if (wireType === 0) {
    return readVarint(bytes, offset)?.offset;
  }
  if (wireType === 1) {
    return offset + 8 <= bytes.length ? offset + 8 : undefined;
  }
  if (wireType === 2) {
    const length = readVarint(bytes, offset);
    return length && length.value <= bytes.length - length.offset
      ? length.offset + length.value
      : undefined;
  }
  if (wireType === 5) {
    return offset + 4 <= bytes.length ? offset + 4 : undefined;
  }
  return undefined;
}

function decodeBase64(value) {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export function isDiscoveryQueueRebuildRequest(inputProtobufEncoded) {
  const bytes = decodeBase64(inputProtobufEncoded);
  if (!bytes) {
    return false;
  }

  let queueType;
  let rebuildQueue;
  for (let offset = 0; offset < bytes.length;) {
    const key = readVarint(bytes, offset);
    if (!key || key.value === 0) {
      return false;
    }
    offset = key.offset;
    const fieldNumber = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    if ((fieldNumber === 1 || fieldNumber === 3) && wireType === 0) {
      const value = readVarint(bytes, offset);
      if (!value) {
        return false;
      }
      if (fieldNumber === 1) {
        queueType = value.value;
      } else {
        rebuildQueue = value.value !== 0;
      }
      offset = value.offset;
      continue;
    }
    const nextOffset = skipField(bytes, wireType, offset);
    if (nextOffset === undefined) {
      return false;
    }
    offset = nextOffset;
  }
  return queueType === 0 && rebuildQueue === true;
}

export function decodeDiscoveryQueueAppIds(buffer) {
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : undefined;
  if (!bytes) {
    return undefined;
  }

  const appIds = [];
  for (let offset = 0; offset < bytes.length;) {
    const key = readVarint(bytes, offset);
    if (!key || key.value === 0) {
      return undefined;
    }
    offset = key.offset;
    const fieldNumber = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    if (fieldNumber === 1 && wireType === 0) {
      const value = readVarint(bytes, offset);
      if (!value || value.value < 1) {
        return undefined;
      }
      appIds.push(value.value);
      offset = value.offset;
      continue;
    }
    if (fieldNumber === 1 && wireType === 2) {
      const length = readVarint(bytes, offset);
      if (!length || length.value > bytes.length - length.offset) {
        return undefined;
      }
      const end = length.offset + length.value;
      offset = length.offset;
      while (offset < end) {
        const value = readVarint(bytes, offset);
        if (!value || value.offset > end || value.value < 1) {
          return undefined;
        }
        appIds.push(value.value);
        offset = value.offset;
      }
      continue;
    }
    const nextOffset = skipField(bytes, wireType, offset);
    if (nextOffset === undefined) {
      return undefined;
    }
    offset = nextOffset;
  }
  return appIds;
}

function appIdKey(appIds) {
  if (!Array.isArray(appIds) || appIds.some((appId) => !Number.isSafeInteger(appId) || appId < 1)) {
    return undefined;
  }
  return appIds.join(",");
}

function getFetchRequest(input, init) {
  const request = typeof Request === "function" && input instanceof Request ? input : undefined;
  const method = init?.method ?? request?.method ?? "GET";
  if (typeof method !== "string" || method.toUpperCase() !== "GET") {
    return undefined;
  }
  try {
    const url = new URL(request?.url ?? String(input), location.href);
    return `${url.origin}${url.pathname}` === DISCOVERY_QUEUE_URL
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function isOctetStream(response) {
  const contentType = response.headers?.get("content-type");
  return typeof contentType === "string" && contentType.split(";", 1)[0].trim().toLowerCase() === "application/octet-stream";
}

function readSnr() {
  try {
    const config = document.querySelector("#application_config[data-config]")?.dataset.config;
    const snr = config ? JSON.parse(config).SNR : undefined;
    return typeof snr === "string" && snr ? snr : undefined;
  } catch {
    return undefined;
  }
}

async function runWithConcurrency(values, worker) {
  let nextIndex = 0;
  const results = new Array(values.length);
  async function consume() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PREFILTER_CONCURRENCY, values.length) }, consume));
  return results;
}

export function startDiscoveryQueuePrefilter({ getStoreItem, getLocalizedTags } = {}) {
  if (typeof window !== "object" || typeof window.fetch !== "function") {
    return () => {};
  }

  const permits = new Map();
  const ruleEngine = createDiscoveryQueueRuleEngine({ getStoreItem });
  const originalFetch = window.fetch;
  let stopped = false;
  let generation = 0;
  let pollTimer;
  let queueCache;
  let originalQueueMultiple;
  let queueMultipleWrapper;

  function grantPermit(appIds) {
    const key = appIdKey(appIds);
    if (key !== undefined && appIds.length > 0) {
      permits.set(key, Date.now() + PERMIT_DURATION_MS);
    }
  }

  function takePermit(appIds) {
    const key = appIdKey(appIds);
    if (key === undefined) {
      return false;
    }
    const expiresAt = permits.get(key);
    permits.delete(key);
    return typeof expiresAt === "number" && expiresAt >= Date.now();
  }

  async function ignoreApp(appId) {
    if (typeof window.g_sessionID !== "string" || !window.g_sessionID) {
      return false;
    }
    const form = new FormData();
    form.set("sessionid", window.g_sessionID);
    form.set("appid", String(appId));
    form.set("remove", "0");
    const snr = readSnr();
    if (snr !== undefined) {
      form.set("snr", snr);
    }
    form.set("ignore_reason", "0");
    try {
      const response = await window.fetch("/recommended/ignorerecommendation", {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        return false;
      }
      const payload = await response.json();
      return payload?.success === true || payload?.success === 1;
    } catch {
      return false;
    }
  }

  async function prefilter(appIds, currentGeneration) {
    let config;
    try {
      config = loadDiscoveryQueueConfig();
    } catch {
      return;
    }
    if (config?.enabled !== true || stopped || currentGeneration !== generation) {
      return;
    }

    const matches = await runWithConcurrency(appIds, async (appId) => {
      try {
        const tags = typeof getLocalizedTags === "function"
          ? await getLocalizedTags(appId)
          : [];
        const result = await ruleEngine.evaluate({
          appId: String(appId),
          tags: Array.isArray(tags) ? tags : [],
          config,
        });
        if (!result?.matched || stopped || currentGeneration !== generation) {
          return false;
        }
        return ignoreApp(appId);
      } catch {
        return false;
      }
    });
    if (stopped || currentGeneration !== generation) {
      return;
    }
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      if (matches[index] === true) {
        appIds.splice(index, 1);
      }
    }
  }

  function wrappedFetch(...args) {
    const responsePromise = Reflect.apply(originalFetch, this, args);
    let request;
    try {
      request = getFetchRequest(args[0], args[1]);
    } catch {
      return responsePromise;
    }
    if (!request || !isDiscoveryQueueRebuildRequest(request.searchParams.get("input_protobuf_encoded"))) {
      return responsePromise;
    }
    void Promise.resolve(responsePromise).then(async (response) => {
      if (stopped || !response?.ok || !isOctetStream(response)) {
        return;
      }
      try {
        const appIds = decodeDiscoveryQueueAppIds(await response.clone().arrayBuffer());
        if (!stopped && appIds) {
          grantPermit(appIds);
        }
      } catch {
        // A malformed or unreadable response is not eligible for prefiltering.
      }
    }).catch(() => {});
    return responsePromise;
  }

  function installQueueWrapper() {
    if (stopped) {
      return;
    }
    const cache = window.StoreItemCache;
    const current = cache?.QueueMultipleAppRequests;
    if (cache && typeof current === "function" && current !== queueMultipleWrapper) {
      queueCache = cache;
      originalQueueMultiple = current;
      queueMultipleWrapper = function wrappedQueueMultiple(appIds, ...args) {
        const result = Reflect.apply(originalQueueMultiple, this, [appIds, ...args]);
        const snapshot = Array.isArray(appIds) ? [...appIds] : undefined;
        if (snapshot && takePermit(snapshot)) {
          void prefilter(appIds, generation);
        }
        return result;
      };
      cache.QueueMultipleAppRequests = queueMultipleWrapper;
    }
    pollTimer = setTimeout(installQueueWrapper, POLL_INTERVAL_MS);
  }

  window.fetch = wrappedFetch;
  installQueueWrapper();

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    generation += 1;
    permits.clear();
    clearTimeout(pollTimer);
    ruleEngine.clear();
    if (window.fetch === wrappedFetch) {
      window.fetch = originalFetch;
    }
    if (queueCache?.QueueMultipleAppRequests === queueMultipleWrapper) {
      queueCache.QueueMultipleAppRequests = originalQueueMultiple;
    }
  };
}
