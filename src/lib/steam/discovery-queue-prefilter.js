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

function createPrefilterReporter(logger, lifecycleId) {
  let checked = 0;
  let ignored = 0;
  let total = 0;
  let batches = 0;
  let element;
  let closed = false;

  function ensureElement() {
    if (closed) {
      return undefined;
    }
    if (element?.isConnected) {
      return element;
    }
    if (!(document.body instanceof HTMLElement)) {
      return undefined;
    }
    element = document.createElement("div");
    element.style.cssText = [
      "position:fixed",
      "top:72px",
      "right:24px",
      "z-index:100000",
      "max-width:360px",
      "padding:12px 16px",
      "border:1px solid rgba(103,193,245,.45)",
      "border-radius:4px",
      "background:rgba(20,30,40,.96)",
      "box-shadow:0 8px 24px rgba(0,0,0,.35)",
      "color:#d6d7d8",
      "font:14px/1.5 Arial,sans-serif",
      "pointer-events:none",
    ].join(";");
    document.body.append(element);
    return element;
  }

  function render(stage) {
    const target = ensureElement();
    if (target) {
      target.textContent = `${stage} · 已检查 ${checked}/${total}，已忽略 ${ignored}`;
    }
  }

  return {
    beginBatch(appIds) {
      batches += 1;
      total += appIds.length;
      render(`正在加载第 ${batches} 批（${appIds.length} 项）`);
      logger?.info("batch.started", {
        appIds: [...appIds],
        batch: batches,
        lifecycleId,
      });
    },
    beginEvaluation() {
      render(`正在筛选第 ${batches} 批`);
    },
    recordEvaluation(appId, result) {
      checked += 1;
      render(`正在筛选第 ${batches} 批`);
      if (result?.matched === true) {
        logger?.info("app.matched", {
          appId,
          lifecycleId,
          reasons: result.reasons,
        });
      }
    },
    recordIgnore(appId, succeeded) {
      if (succeeded) {
        ignored += 1;
        render(`正在忽略第 ${batches} 批命中项`);
        logger?.info("ignore.succeeded", { appId, lifecycleId });
      } else {
        logger?.warn("ignore.failed", {
          appId,
          lifecycleId,
        });
      }
    },
    finishBatch(retainedAppIds, matchedAppIds) {
      logger?.info("batch.partitioned", {
        batch: batches,
        checked,
        ignored,
        lifecycleId,
        matchedAppIds: [...matchedAppIds],
        retainedAppIds: [...retainedAppIds],
      });
    },
    close() {
      closed = true;
      element?.remove();
      element = undefined;
    },
  };
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

export function startDiscoveryQueuePrefilter({
  getStoreItem,
  getLocalizedTags,
  logger,
  prepareStoreItems,
} = {}) {
  if (typeof window !== "object" || typeof window.fetch !== "function") {
    return () => {};
  }

  const lifecycleId = logger?.nextId?.("prefilter") ?? "prefilter";
  const prefilterLogger = logger?.child?.("prefilter", { lifecycleId }) ?? logger;
  const permits = new Map();
  const deliveredDialogs = new WeakSet();
  const ruleEngine = createDiscoveryQueueRuleEngine({
    getStoreItem,
    logger: prefilterLogger?.child?.("rules", { lifecycleId }) ?? prefilterLogger,
  });
  const originalFetch = window.fetch;
  let stopped = false;
  let generation = 0;
  let pollTimer;
  let queueCache;
  let originalQueueMultiple;
  let queueMultipleWrapper;
  prefilterLogger?.info("lifecycle.started", { lifecycleId });

  function grantPermit(appIds, request, args, receiver) {
    const key = appIdKey(appIds);
    if (key !== undefined && appIds.length > 0) {
      permits.set(key, {
        args,
        expiresAt: Date.now() + PERMIT_DURATION_MS,
        receiver,
        request,
      });
      prefilterLogger?.debug("permit.granted", {
        appIds: [...appIds],
        expiresInMs: PERMIT_DURATION_MS,
        lifecycleId,
        rebuild: request.queueRequest.rebuild,
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
    const valid = permit?.expiresAt >= Date.now();
    prefilterLogger?.debug("permit.taken", {
      appIds: [...appIds],
      lifecycleId,
      result: !permit ? "missing" : valid ? "accepted" : "expired",
    });
    return valid ? permit : undefined;
  }

  async function ignoreApp(appId) {
    if (typeof window.g_sessionID !== "string" || !window.g_sessionID) {
      prefilterLogger?.warn("ignore.skipped", {
        appId,
        lifecycleId,
        reason: "missing-session",
      });
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
    const startedAt = performance.now();
    prefilterLogger?.debug("ignore.request.started", { appId, lifecycleId });
    try {
      const response = await Reflect.apply(originalFetch, window, [
        "/recommended/ignorerecommendation",
        {
          method: "POST",
          body: form,
        },
      ]);
      if (!response.ok) {
        prefilterLogger?.warn("ignore.request.http-error", {
          appId,
          durationMs: performance.now() - startedAt,
          lifecycleId,
          status: response.status,
          statusText: response.statusText,
        });
        return false;
      }
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        prefilterLogger?.error("ignore.response.parse-error", error, {
          appId,
          durationMs: performance.now() - startedAt,
          lifecycleId,
          status: response.status,
        });
        return false;
      }
      const succeeded = payload?.success === true || payload?.success === 1;
      const data = {
        appId,
        durationMs: performance.now() - startedAt,
        lifecycleId,
        payload,
        status: response.status,
      };
      if (succeeded) {
        prefilterLogger?.debug("ignore.request.completed", data);
      } else {
        prefilterLogger?.warn("ignore.response.rejected", data);
      }
      return succeeded;
    } catch (error) {
      prefilterLogger?.error("ignore.request.error", error, {
        appId,
        durationMs: performance.now() - startedAt,
        lifecycleId,
      });
      return false;
    }
  }

  async function prefilter(appIds, config, currentGeneration, reporter) {
    const requiredLanguages = config.requiredLanguages?.enabled === true
      ? config.requiredLanguages.value
      : [];
    if (typeof prepareStoreItems === "function") {
      prefilterLogger?.debug("batch.prepare.started", {
        appIds: [...appIds],
        currentGeneration,
        lifecycleId,
        requiredLanguages: [...requiredLanguages],
      });
      try {
        await prepareStoreItems(appIds, requiredLanguages);
        prefilterLogger?.debug("batch.prepare.completed", {
          appIds: [...appIds],
          currentGeneration,
          lifecycleId,
        });
      } catch (error) {
        prefilterLogger?.error("batch.prepare.error", error, {
          appIds: [...appIds],
          currentGeneration,
          lifecycleId,
        });
        throw error;
      }
    }
    if (stopped || currentGeneration !== generation) {
      prefilterLogger?.info("generation.cancelled", {
        currentGeneration,
        generation,
        lifecycleId,
        stage: "after-prepare",
        stopped,
      });
      return undefined;
    }
    reporter?.beginEvaluation();
    const matches = await runWithConcurrency(appIds, async (appId) => {
      let report = { matched: false, reasons: [] };
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
        report = {
          matched: true,
          reasons: Array.isArray(result.reasons) ? result.reasons : [],
        };
        return true;
      } catch (error) {
        prefilterLogger?.error("app.evaluation.error", error, {
          appId,
          currentGeneration,
          lifecycleId,
        });
        return false;
      } finally {
        reporter?.recordEvaluation(appId, report);
      }
    });
    if (stopped || currentGeneration !== generation) {
      prefilterLogger?.info("generation.cancelled", {
        currentGeneration,
        generation,
        lifecycleId,
        stage: "after-evaluation",
        stopped,
      });
      return undefined;
    }
    const retainedAppIds = appIds.filter((_, index) => matches[index] !== true);
    const matchedAppIds = appIds.filter((_, index) => matches[index] === true);
    reporter?.finishBatch(retainedAppIds, matchedAppIds);
    const ignoreCompletion = runWithConcurrency(matchedAppIds, async (appId) => {
      const succeeded = await ignoreApp(appId);
      reporter?.recordIgnore(appId, succeeded);
      return succeeded;
    });
    prefilterLogger?.info("batch.ignore.deferred", {
      appIds: [...matchedAppIds],
      lifecycleId,
      retainedAppIds: [...retainedAppIds],
    });
    return { ignoreCompletion, retainedAppIds };
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
    reporter,
  ) {
    let fetchArgs = createRebuildFetchArgs(permit.args, permit.request);
    if (!fetchArgs) {
      prefilterLogger?.warn("summary.selected", {
        lifecycleId,
        reason: "rebuild-request-unavailable",
      });
      return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
    }

    while (!stopped && currentGeneration === generation) {
      let response;
      try {
        response = await Reflect.apply(originalFetch, permit.receiver, fetchArgs);
      } catch (error) {
        prefilterLogger?.error("rebuild.request.error", error, { lifecycleId });
        prefilterLogger?.warn("summary.selected", {
          lifecycleId,
          reason: "rebuild-request-error",
        });
        return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
      }
      if (!response?.ok || !isOctetStream(response)) {
        prefilterLogger?.warn("summary.selected", {
          contentType: response?.headers?.get?.("content-type"),
          lifecycleId,
          reason: "rebuild-invalid-response",
          status: response?.status,
        });
        return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
      }

      let appIds;
      try {
        appIds = decodeDiscoveryQueueAppIds(await response.clone().arrayBuffer());
      } catch (error) {
        prefilterLogger?.error("rebuild.response.decode-error", error, {
          lifecycleId,
          status: response.status,
        });
        prefilterLogger?.warn("summary.selected", {
          lifecycleId,
          reason: "rebuild-decode-error",
        });
        return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
      }
      const key = appIdKey(appIds);
      if (!appIds || appIds.length === 0 || key === undefined || seenBatches.has(key)) {
        prefilterLogger?.warn("summary.selected", {
          appIds,
          lifecycleId,
          reason: !appIds
            ? "rebuild-invalid-appids"
            : appIds.length === 0
              ? "queue-exhausted"
              : key === undefined
                ? "rebuild-invalid-appid-key"
                : "rebuild-repeated-batch",
        });
        return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
      }
      seenBatches.add(key);

      reporter?.beginBatch(appIds);
      try {
        await Reflect.apply(originalQueueMultiple, queueReceiver, [appIds, dataRequest]);
      } catch (error) {
        prefilterLogger?.error("rebuild.store-items.error", error, {
          appIds: [...appIds],
          lifecycleId,
        });
        prefilterLogger?.warn("summary.selected", {
          lifecycleId,
          reason: "rebuild-store-items-error",
        });
        return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
      }
      const filteredBatch = await prefilter(
        appIds,
        config,
        currentGeneration,
        reporter,
      );
      if (!filteredBatch) {
        prefilterLogger?.info("display.original-batch", {
          appIds: [...appIds],
          lifecycleId,
          reason: "generation-cancelled",
        });
        return appIds;
      }
      if (filteredBatch.retainedAppIds.length > 0) {
        prefilterLogger?.info("display.retained", {
          appIds: [...filteredBatch.retainedAppIds],
          lifecycleId,
          source: "rebuild",
        });
        return filteredBatch.retainedAppIds;
      }
      prefilterLogger?.info("rebuild.next-batch", {
        lifecycleId,
        reason: "batch-fully-filtered",
      });
      await filteredBatch.ignoreCompletion;
    }
    prefilterLogger?.warn("summary.selected", {
      currentGeneration,
      generation,
      lifecycleId,
      reason: stopped
        ? "stopped-during-rebuild"
        : "generation-changed-during-rebuild",
      stopped,
    });
    return [DISCOVERY_QUEUE_SUMMARY_APP_ID];
  }

  function wrappedFetch(...args) {
    const responsePromise = Reflect.apply(originalFetch, this, args);
    let request;
    try {
      request = getFetchRequest(args[0], args[1]);
    } catch (error) {
      prefilterLogger?.error("fetch.intercept.parse-error", error, { lifecycleId });
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
      } catch (error) {
        prefilterLogger?.error("fetch.response.decode-error", error, {
          lifecycleId,
          status: response.status,
        });
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
        const snapshot = Array.isArray(appIds) ? [...appIds] : undefined;
        let result;
        try {
          result = Reflect.apply(originalQueueMultiple, this, [appIds, ...args]);
        } catch (error) {
          prefilterLogger?.error("queue.store-items.sync-error", error, {
            appIds: snapshot,
            dataRequest: args[0],
            lifecycleId,
          });
          throw error;
        }
        const expectedKey = snapshot && appIdKey(snapshot);
        const dialog = getDiscoveryQueueDialog();
        if (
          expectedKey === undefined ||
          snapshot.length === 0 ||
          !dialog ||
          !isDiscoveryQueueDataRequest(args[0])
        ) {
          if (expectedKey !== undefined && snapshot.length > 0) {
            prefilterLogger?.debug("queue.intercept.skipped", {
              appIds: snapshot,
              hasDialog: Boolean(dialog),
              isDiscoveryQueueDataRequest: isDiscoveryQueueDataRequest(args[0]),
              lifecycleId,
              reason: !dialog ? "dialog-missing" : "data-request-mismatch",
            });
          }
          return result;
        }

        const permit = takePermit(snapshot);
        if (deliveredDialogs.has(dialog) && !permit?.request.queueRequest.rebuild) {
          prefilterLogger?.info("queue.intercept.skipped", {
            appIds: snapshot,
            lifecycleId,
            reason: "dialog-already-delivered",
          });
          return result;
        }
        deliveredDialogs.add(dialog);

        let config;
        try {
          config = loadDiscoveryQueueConfig(
            prefilterLogger?.child?.("config", { lifecycleId }) ?? prefilterLogger,
          );
        } catch (error) {
          prefilterLogger?.error("config.load.error", error, { lifecycleId });
          return result;
        }
        if (config?.enabled !== true || !hasActiveRules(config)) {
          prefilterLogger?.info("queue.intercept.skipped", {
            appIds: snapshot,
            lifecycleId,
            reason: config?.enabled !== true ? "disabled" : "no-active-rules",
          });
          return result;
        }

        const currentGeneration = generation;
        const queueReceiver = this;
        const reporter = createPrefilterReporter(prefilterLogger, lifecycleId);
        prefilterLogger?.info("queue.intercepted", {
          appIds: snapshot,
          generation: currentGeneration,
          hasPermit: Boolean(permit),
          lifecycleId,
        });
        reporter.beginBatch(snapshot);
        return Promise.resolve(result).then(
          async (value) => {
            const filteredBatch = await prefilter(
              snapshot,
              config,
              currentGeneration,
              reporter,
            );
            if (!filteredBatch || stopped || currentGeneration !== generation) {
              prefilterLogger?.info("display.original-batch", {
                appIds: snapshot,
                lifecycleId,
                reason: "generation-cancelled",
              });
              return value;
            }
            if (filteredBatch.retainedAppIds.length > 0) {
              replaceAppIds(appIds, filteredBatch.retainedAppIds);
              prefilterLogger?.info("display.retained", {
                appIds: [...filteredBatch.retainedAppIds],
                lifecycleId,
                source: "initial",
              });
              return value;
            }
            await filteredBatch.ignoreCompletion;
            if (stopped || currentGeneration !== generation) {
              prefilterLogger?.info("display.original-batch", {
                appIds: snapshot,
                currentGeneration,
                generation,
                lifecycleId,
                reason: stopped
                  ? "stopped-after-ignore"
                  : "generation-changed-after-ignore",
                stopped,
              });
              return value;
            }
            if (!permit) {
              prefilterLogger?.warn("summary.selected", {
                lifecycleId,
                reason: "fully-filtered-without-permit",
              });
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
              reporter,
            );
            replaceAppIds(appIds, nextAppIds);
            return value;
          },
          (error) => {
            prefilterLogger?.error("queue.store-items.async-error", error, {
              appIds: snapshot,
              dataRequest: args[0],
              lifecycleId,
            });
            throw error;
          },
        ).finally(() => reporter.close());
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
    prefilterLogger?.info("lifecycle.stopped", { generation, lifecycleId });
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
