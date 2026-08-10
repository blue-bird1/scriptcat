import { loadDiscoveryQueueConfig } from "./discovery-queue-config.js";
import { createDiscoveryQueueRuleEngine } from "./discovery-queue-rules.js";

const DISCOVERY_QUEUE_URL =
  "https://api.steampowered.com/IStoreService/GetDiscoveryQueue/v1";
const DISCOVERY_QUEUE_DIALOG_SELECTOR =
  '[role="dialog"]:has(a[href*="/explore"][href*="dq=widget"])';
const PREFILTER_CONCURRENCY = 4;
const DISCOVERY_QUEUE_SUMMARY_APP_ID = 1;

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

function encodeVarint(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }
  const bytes = [];
  let remaining = value;
  do {
    const byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(byte | (remaining > 0 ? 0x80 : 0));
  } while (remaining > 0);
  return bytes;
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

function rewriteDiscoveryQueueAppIds(buffer, retainedAppIds) {
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : undefined;
  const fields = bytes && readFields(bytes);
  const originalAppIds = bytes && decodeDiscoveryQueueAppIds(bytes);
  if (!bytes || !fields || !originalAppIds || !Array.isArray(retainedAppIds)) {
    return undefined;
  }

  if (retainedAppIds.some((appId) => !Number.isSafeInteger(appId) || appId < 1)) {
    return undefined;
  }

  const payload = retainedAppIds.flatMap((appId) => encodeVarint(appId) ?? []);
  const length = encodeVarint(payload.length);
  if (!length || (payload.length === 0 && retainedAppIds.length > 0)) {
    return undefined;
  }
  const replacement = retainedAppIds.length > 0
    ? [0x0a, ...length, ...payload]
    : [];
  const output = [];
  let inserted = false;
  for (const field of fields) {
    if (field.fieldNumber === 1) {
      if (!inserted) {
        output.push(...replacement);
        inserted = true;
      }
    } else {
      output.push(...bytes.subarray(field.start, field.end));
    }
  }
  if (!inserted) {
    output.push(...replacement);
  }
  return Uint8Array.from(output);
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

function replaceResponseBody(response, body) {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
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

export function startDiscoveryQueuePrefilter({
  getStoreItem,
  getLocalizedTags,
  loadStoreItems,
} = {}) {
  if (typeof window !== "object" || typeof window.fetch !== "function") {
    return () => {};
  }

  const ruleEngine = createDiscoveryQueueRuleEngine({ getStoreItem });
  const originalFetch = window.fetch;
  let stopped = false;
  let generation = 0;

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
    if (stopped || currentGeneration !== generation) {
      return undefined;
    }
    if (typeof loadStoreItems !== "function" || !await loadStoreItems(appIds)) {
      return undefined;
    }
    if (stopped || currentGeneration !== generation) {
      return undefined;
    }

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

  async function wrappedFetch(...args) {
    let request;
    try {
      request = getFetchRequest(args[0], args[1]);
    } catch {
      return Reflect.apply(originalFetch, this, args);
    }
    if (!request?.queueRequest.standard) {
      return Reflect.apply(originalFetch, this, args);
    }

    let fetchArgs = args;
    let currentRequest = request;
    const currentGeneration = generation;
    const seenBatches = new Set();
    let config;
    let transactionStarted = false;
    while (true) {
      const response = await Reflect.apply(originalFetch, this, fetchArgs);
      if (stopped || currentGeneration !== generation || !response?.ok || !isOctetStream(response)) {
        return response;
      }

      if (!transactionStarted) {
        if (!getDiscoveryQueueDialog()) {
          return response;
        }
        try {
          config = loadDiscoveryQueueConfig();
        } catch {
          return response;
        }
        if (config?.enabled !== true || !hasActiveRules(config)) {
          return response;
        }
        transactionStarted = true;
      }

      let buffer;
      let appIds;
      try {
        buffer = await response.clone().arrayBuffer();
        appIds = decodeDiscoveryQueueAppIds(buffer);
      } catch {
        return response;
      }
      if (!appIds) {
        return response;
      }
      if (appIds.length === 0) {
        const summaryBody = rewriteDiscoveryQueueAppIds(buffer, [DISCOVERY_QUEUE_SUMMARY_APP_ID]);
        return summaryBody ? replaceResponseBody(response, summaryBody) : response;
      }

      const batchKey = appIdKey(appIds);
      if (batchKey === undefined || seenBatches.has(batchKey)) {
        const summaryBody = rewriteDiscoveryQueueAppIds(buffer, [DISCOVERY_QUEUE_SUMMARY_APP_ID]);
        return summaryBody ? replaceResponseBody(response, summaryBody) : response;
      }
      seenBatches.add(batchKey);

      const retainedAppIds = await prefilter(appIds, config, currentGeneration);
      if (!retainedAppIds || stopped || currentGeneration !== generation) {
        return response;
      }
      if (retainedAppIds.length > 0) {
        const body = rewriteDiscoveryQueueAppIds(buffer, retainedAppIds);
        return body ? replaceResponseBody(response, body) : response;
      }

      const rebuildArgs = createRebuildFetchArgs(fetchArgs, currentRequest);
      if (!rebuildArgs) {
        const summaryBody = rewriteDiscoveryQueueAppIds(buffer, [DISCOVERY_QUEUE_SUMMARY_APP_ID]);
        return summaryBody ? replaceResponseBody(response, summaryBody) : response;
      }
      fetchArgs = rebuildArgs;
      currentRequest = getFetchRequest(fetchArgs[0], fetchArgs[1]);
      if (!currentRequest) {
        const summaryBody = rewriteDiscoveryQueueAppIds(buffer, [DISCOVERY_QUEUE_SUMMARY_APP_ID]);
        return summaryBody ? replaceResponseBody(response, summaryBody) : response;
      }
    }
  }

  window.fetch = wrappedFetch;

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    generation += 1;
    ruleEngine.clear();
    if (window.fetch === wrappedFetch) {
      window.fetch = originalFetch;
    }
  };
}
