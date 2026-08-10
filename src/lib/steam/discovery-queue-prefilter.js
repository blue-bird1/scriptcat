import { loadDiscoveryQueueConfig } from "./discovery-queue-config.js";
import { createDiscoveryQueueRuleEngine } from "./discovery-queue-rules.js";

const DISCOVERY_QUEUE_URL =
  "https://api.steampowered.com/IStoreService/GetDiscoveryQueue/v1";
const DISCOVERY_QUEUE_DIALOG_SELECTOR =
  '[role="dialog"]:has(a[href*="/explore"][href*="dq=widget"])';
const PERMIT_DURATION_MS = 10_000;
const PREFILTER_CONCURRENCY = 4;
const DISCOVERY_QUEUE_SUMMARY_APP_ID = 1;
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

function encodeBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function readFields(bytes) {
  const fields = [];
  for (let offset = 0; offset < bytes.length;) {
    const start = offset;
    const key = readVarint(bytes, offset);
    if (!key || key.value === 0) {
      return undefined;
    }
    offset = key.offset;
    const fieldNumber = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    const end = skipField(bytes, wireType, offset);
    if (end === undefined) {
      return undefined;
    }
    fields.push({ start, keyEnd: offset, end, fieldNumber, wireType });
    offset = end;
  }
  return fields;
}

function parseDiscoveryQueueRequest(inputProtobufEncoded) {
  const bytes = decodeBase64(inputProtobufEncoded);
  const fields = bytes && readFields(bytes);
  if (!bytes || !fields) {
    return undefined;
  }

  let queueType;
  let rebuildQueue = false;
  for (const field of fields) {
    if ((field.fieldNumber === 1 || field.fieldNumber === 3) && field.wireType === 0) {
      const value = readVarint(bytes, field.keyEnd);
      if (!value || value.offset !== field.end) {
        return undefined;
      }
      if (field.fieldNumber === 1) {
        queueType = value.value;
      } else {
        rebuildQueue = value.value !== 0;
      }
    }
  }
  return {
    bytes,
    fields,
    standard: queueType === undefined || queueType === 0,
    rebuild: rebuildQueue,
  };
}

export function isDiscoveryQueueRebuildRequest(inputProtobufEncoded) {
  const request = parseDiscoveryQueueRequest(inputProtobufEncoded);
  return request?.standard === true && request.rebuild === true;
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

function withDiscoveryQueueRebuild(inputProtobufEncoded) {
  const request = parseDiscoveryQueueRequest(inputProtobufEncoded);
  if (!request?.standard) {
    return undefined;
  }

  const output = [];
  let inserted = false;
  for (const field of request.fields) {
    if (field.fieldNumber === 3 && field.wireType === 0) {
      if (!inserted) {
        output.push(0x18, 0x01);
        inserted = true;
      }
    } else {
      output.push(...request.bytes.subarray(field.start, field.end));
    }
  }
  if (!inserted) {
    output.push(0x18, 0x01);
  }
  return encodeBase64(Uint8Array.from(output));
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
    const pathname = url.pathname.replace(/\/+$/, "");
    if (`${url.origin}${pathname}` !== DISCOVERY_QUEUE_URL) {
      return undefined;
    }
    const encoded = url.searchParams.get("input_protobuf_encoded");
    const queueRequest = parseDiscoveryQueueRequest(encoded);
    return queueRequest ? { url, encoded, queueRequest } : undefined;
  } catch {
    return undefined;
  }
}

function createRebuildFetchArgs(args, request) {
  const encoded = withDiscoveryQueueRebuild(request.encoded);
  if (!encoded) {
    return undefined;
  }
  const url = new URL(request.url);
  url.searchParams.set("input_protobuf_encoded", encoded);
  const input = args[0];
  if (typeof Request === "function" && input instanceof Request) {
    return [new Request(url.href, input), args[1]];
  }
  if (input instanceof URL) {
    return [url, args[1]];
  }
  return [url.href, args[1]];
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

function hasActiveRules(config) {
  return Boolean(
    config?.minimumPositiveRate?.enabled ||
      config?.minimumReviewCount?.enabled ||
      config?.maximumPrice?.enabled ||
      config?.minimumDiscount?.enabled ||
      config?.earliestReleaseDate?.enabled ||
      config?.ignoreFree ||
      config?.ignoreUnreviewed ||
      config?.ignoreDlc ||
      config?.ignoreProfileFeaturesLimited ||
      config?.excludedTags?.enabled ||
      config?.requiredLanguages?.enabled,
  );
}

function getDiscoveryQueueDialog() {
  const dialog = document.querySelector(DISCOVERY_QUEUE_DIALOG_SELECTOR);
  return dialog instanceof HTMLElement ? dialog : undefined;
}

function isDiscoveryQueueDataRequest(value) {
  return Boolean(
    value?.include_assets === true &&
      value?.include_trailers === true &&
      value?.include_basic_info === true &&
      value?.include_tag_count === 20 &&
      value?.include_release === true &&
      value?.include_platforms === true &&
      value?.include_screenshots === true &&
      value?.include_reviews === true,
  );
}

export function startDiscoveryQueuePrefilter({ getStoreItem, getLocalizedTags } = {}) {
  if (typeof window !== "object" || typeof window.fetch !== "function") {
    return () => {};
  }

  const permits = new Map();
  const deliveredDialogs = new WeakSet();
  const ruleEngine = createDiscoveryQueueRuleEngine({ getStoreItem });
  const originalFetch = window.fetch;
  let stopped = false;
  let generation = 0;
  let pollTimer;
  let queueCache;
  let originalQueueMultiple;
  let queueMultipleWrapper;

  function grantPermit(appIds, request, args, receiver) {
    const key = appIdKey(appIds);
    if (key !== undefined && appIds.length > 0) {
      permits.set(key, {
        args,
        expiresAt: Date.now() + PERMIT_DURATION_MS,
        receiver,
        request,
      });
    }
  }

  function takePermit(appIds) {
    const key = appIdKey(appIds);
    if (key === undefined) {
      return undefined;
    }
    const permit = permits.get(key);
    permits.delete(key);
    return permit?.expiresAt >= Date.now() ? permit : undefined;
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
      const response = await Reflect.apply(originalFetch, window, [
        "/recommended/ignorerecommendation",
        {
          method: "POST",
          body: form,
        },
      ]);
      if (!response.ok) {
        return false;
      }
      const payload = await response.json();
      return payload?.success === true || payload?.success === 1;
    } catch {
      return false;
    }
  }

  async function prefilter(appIds, config, currentGeneration) {
    const matches = await runWithConcurrency(appIds, async (appId) => {
      try {
        const tags = config.excludedTags?.enabled && typeof getLocalizedTags === "function"
          ? await getLocalizedTags(String(appId))
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
      return undefined;
    }
    return appIds.filter((_, index) => matches[index] !== true);
  }

  function replaceAppIds(target, replacement) {
    target.splice(0, target.length, ...replacement);
  }

  async function loadNextVisibleBatch(
    permit,
    dataRequest,
    queueReceiver,
    config,
    currentGeneration,
    seenBatches,
  ) {
    let fetchArgs = createRebuildFetchArgs(permit.args, permit.request);
    if (!fetchArgs) {
      return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
    }

    while (!stopped && currentGeneration === generation) {
      let response;
      try {
        response = await Reflect.apply(originalFetch, permit.receiver, fetchArgs);
      } catch {
        return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
      }
      if (!response?.ok || !isOctetStream(response)) {
        return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
      }

      let appIds;
      try {
        appIds = decodeDiscoveryQueueAppIds(await response.clone().arrayBuffer());
      } catch {
        return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
      }
      const key = appIdKey(appIds);
      if (!appIds || appIds.length === 0 || key === undefined || seenBatches.has(key)) {
        return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
      }
      seenBatches.add(key);

      try {
        await Reflect.apply(originalQueueMultiple, queueReceiver, [appIds, dataRequest]);
      } catch {
        return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
      }
      const retainedAppIds = await prefilter(appIds, config, currentGeneration);
      if (!retainedAppIds) {
        return appIds;
      }
      if (retainedAppIds.length > 0) {
        return retainedAppIds;
      }
    }
    return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
  }

  function wrappedFetch(...args) {
    const responsePromise = Reflect.apply(originalFetch, this, args);
    let request;
    try {
      request = getFetchRequest(args[0], args[1]);
    } catch {
      return responsePromise;
    }
    if (!request?.queueRequest.standard) {
      return responsePromise;
    }
    const receiver = this;
    return Promise.resolve(responsePromise).then(async (response) => {
      if (stopped || !response?.ok || !isOctetStream(response)) {
        return response;
      }
      try {
        const appIds = decodeDiscoveryQueueAppIds(await response.clone().arrayBuffer());
        if (!stopped && appIds) {
          grantPermit(appIds, request, args, receiver);
        }
      } catch {
        return response;
      }
      return response;
    });
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
        const expectedKey = snapshot && appIdKey(snapshot);
        const dialog = getDiscoveryQueueDialog();
        if (
          expectedKey === undefined ||
          snapshot.length === 0 ||
          !dialog ||
          !isDiscoveryQueueDataRequest(args[0])
        ) {
          return result;
        }

        const permit = takePermit(snapshot);
        if (deliveredDialogs.has(dialog) && !permit?.request.queueRequest.rebuild) {
          return result;
        }
        deliveredDialogs.add(dialog);

        let config;
        try {
          config = loadDiscoveryQueueConfig();
        } catch {
          return result;
        }
        if (config?.enabled !== true || !hasActiveRules(config)) {
          return result;
        }

        const currentGeneration = generation;
        const queueReceiver = this;
        return Promise.resolve(result).then(async (value) => {
          const retainedAppIds = await prefilter(snapshot, config, currentGeneration);
          if (!retainedAppIds || stopped || currentGeneration !== generation) {
            return value;
          }
          if (retainedAppIds.length > 0) {
            replaceAppIds(appIds, retainedAppIds);
            return value;
          }
          if (!permit) {
            replaceAppIds(appIds, [DISCOVERY_QUEUE_SUMMARY_APP_ID]);
            return value;
          }
          const nextAppIds = await loadNextVisibleBatch(
            permit,
            args[0],
            queueReceiver,
            config,
            currentGeneration,
            new Set([expectedKey]),
          );
          replaceAppIds(appIds, nextAppIds);
          return value;
        });
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
