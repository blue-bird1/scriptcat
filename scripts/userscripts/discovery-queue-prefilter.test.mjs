import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeDiscoveryQueueAppIds,
  isDiscoveryQueueRebuildRequest,
  startDiscoveryQueuePrefilter,
} from "../../src/lib/steam/discovery-queue-prefilter.js";

// Wire fixtures encoded from Steam's current IStoreService protobuf schema.
const REBUILD_STANDARD_QUEUE = "CAAYAQ=="; // queue_type = 0, rebuild_queue = true
const REBUILD_DEFAULT_QUEUE = "GAE="; // queue_type omitted at its protobuf default, rebuild_queue = true
const REBUILD_PREVIEW_QUEUE = "CAAYAA=="; // queue_type = 0, rebuild_queue = false
const REBUILD_OTHER_QUEUE = "CAEYARgB"; // queue_type = 1, rebuild_queue = true

test("only Steam's standard rebuild queue protobuf request is eligible", () => {
  assert.equal(isDiscoveryQueueRebuildRequest(REBUILD_STANDARD_QUEUE), true);
  assert.equal(isDiscoveryQueueRebuildRequest(REBUILD_DEFAULT_QUEUE), true);
  assert.equal(isDiscoveryQueueRebuildRequest(REBUILD_PREVIEW_QUEUE), false);
  assert.equal(isDiscoveryQueueRebuildRequest(REBUILD_OTHER_QUEUE), false);
});

test("discovery queue response appids decode from packed and unpacked protobuf fields", () => {
  const packed = Uint8Array.from([0x0a, 0x04, 0x01, 0x02, 0xe0, 0x03]);
  const unpacked = Uint8Array.from([0x08, 0x01, 0x08, 0x02, 0x08, 0xe0, 0x03]);
  assert.deepEqual(decodeDiscoveryQueueAppIds(packed), [1, 2, 480]);
  assert.deepEqual(decodeDiscoveryQueueAppIds(unpacked), [1, 2, 480]);
});

test("unknown protobuf fields are skipped without changing queue appids", () => {
  const requestWithUnknownField = "CAAYAUoDdW5r"; // adds field 9 = "unk"
  const responseWithUnknownField = Uint8Array.from([
    0x12, 0x03, 0x75, 0x6e, 0x6b, // unknown field 2 = "unk"
    0x0a, 0x02, 0x80, 0x01, // packed appid 128
  ]);
  assert.equal(isDiscoveryQueueRebuildRequest(requestWithUnknownField), true);
  assert.deepEqual(decodeDiscoveryQueueAppIds(responseWithUnknownField), [128]);
});

const INITIAL_QUEUE_URL =
  "https://api.steampowered.com/IStoreService/GetDiscoveryQueue/v1/?input_protobuf_encoded=EgJDTjAB&access_token=token";
const DISCOVERY_QUEUE_DATA_REQUEST = {
  include_assets: true,
  include_trailers: true,
  include_basic_info: true,
  include_tag_count: 20,
  include_release: true,
  include_platforms: true,
  include_screenshots: true,
  include_reviews: true,
};

function encodeQueueResponse(appIds, extraFields = []) {
  const payload = appIds.flatMap((appId) => {
    const bytes = [];
    let remaining = appId;
    do {
      const byte = remaining % 128;
      remaining = Math.floor(remaining / 128);
      bytes.push(byte | (remaining > 0 ? 0x80 : 0));
    } while (remaining > 0);
    return bytes;
  });
  return Uint8Array.from([
    0x0a,
    payload.length,
    ...payload,
    ...extraFields,
  ]);
}

async function runPrefilter({
  dialogPresent = true,
  queueBodies,
  successfulIgnores = [],
  matchingAppIds = [],
}) {
  const calls = [];
  const responses = queueBodies.map((body) => new Response(body, {
    headers: {
      "content-length": String(body.length),
      "content-type": "application/octet-stream",
    },
  }));
  const initialResponse = responses[0];
  const originalGlobals = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    location: globalThis.location,
    localStorage: globalThis.localStorage,
    window: globalThis.window,
  };
  const originalFetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.steampowered.com/")) {
      const requestUrl = new URL(url);
      assert.equal(requestUrl.searchParams.get("access_token"), "token");
      calls.push([
        "queue",
        isDiscoveryQueueRebuildRequest(
          requestUrl.searchParams.get("input_protobuf_encoded"),
        ),
      ]);
      const response = responses.shift();
      assert.ok(response, "unexpected extra queue rebuild");
      return response;
    }
    assert.equal(url, "/recommended/ignorerecommendation");
    assert.equal(init?.method, "POST");
    const appId = Number(init.body.get("appid"));
    calls.push(["ignore", appId]);
    return Response.json({ success: successfulIgnores.includes(appId) ? 1 : 2 });
  };
  globalThis.document = {
    querySelector(selector) {
      if (selector.startsWith("#application_config")) {
        return { dataset: { config: JSON.stringify({ SNR: "1_4_4_" }) } };
      }
      if (selector.startsWith('[role="dialog"]')) {
        return dialogPresent ? new globalThis.HTMLElement() : null;
      }
      return null;
    },
  };
  globalThis.HTMLElement = class HTMLElement {};
  globalThis.location = { href: "https://store.steampowered.com/" };
  globalThis.localStorage = {
    getItem() {
      return JSON.stringify({ version: 1, enabled: true, ignoreFree: true });
    },
  };
  globalThis.window = {
    StoreItemCache: {
      async QueueMultipleAppRequests(appIds) {
        calls.push(["store-items", [...appIds]]);
        return 1;
      },
    },
    fetch: originalFetch,
    g_sessionID: "session",
  };

  const stop = startDiscoveryQueuePrefilter({
    async getStoreItem(appId) {
      const numericAppId = Number(appId);
      return {
        appId: numericAppId,
        success: 1,
        isFree: matchingAppIds.includes(numericAppId),
      };
    },
  });
  try {
    const response = await window.fetch(INITIAL_QUEUE_URL);
    const body = new Uint8Array(await response.clone().arrayBuffer());
    const appIds = decodeDiscoveryQueueAppIds(body);
    await window.StoreItemCache.QueueMultipleAppRequests(
      appIds,
      DISCOVERY_QUEUE_DATA_REQUEST,
    );
    return {
      appIds,
      body,
      calls,
      initialResponse,
      response,
    };
  } finally {
    stop();
    globalThis.document = originalGlobals.document;
    globalThis.HTMLElement = originalGlobals.HTMLElement;
    globalThis.location = originalGlobals.location;
    globalThis.localStorage = originalGlobals.localStorage;
    globalThis.window = originalGlobals.window;
  }
}

test("original protobuf response stays untouched while fully filtered batches rebuild", async () => {
  const initialBody = encodeQueueResponse([42]);
  const result = await runPrefilter({
    queueBodies: [
      initialBody,
      encodeQueueResponse([43]),
      encodeQueueResponse([44]),
    ],
    successfulIgnores: [42, 43],
    matchingAppIds: [42, 43],
  });
  assert.strictEqual(result.response, result.initialResponse);
  assert.deepEqual(result.body, initialBody);
  assert.deepEqual(result.appIds, [44]);
  assert.deepEqual(result.calls, [
    ["queue", false],
    ["store-items", [42]],
    ["ignore", 42],
    ["queue", true],
    ["store-items", [43]],
    ["ignore", 43],
    ["queue", true],
    ["store-items", [44]],
  ]);
});

test("successful ignores are removed before delivery while failures stay ordered", async () => {
  const result = await runPrefilter({
    queueBodies: [
      Uint8Array.from([
        0x12, 0x03, 0x75, 0x6e, 0x6b,
        0x0a, 0x03, 0x2a, 0x2b, 0x2c,
        0x28, 0x01,
      ]),
    ],
    successfulIgnores: [42],
    matchingAppIds: [42, 43],
  });
  assert.deepEqual(result.appIds, [43, 44]);
  assert.deepEqual([...result.body], [
    0x12, 0x03, 0x75, 0x6e, 0x6b,
    0x0a, 0x03, 0x2a, 0x2b, 0x2c,
    0x28, 0x01,
  ]);
  assert.strictEqual(result.response, result.initialResponse);
  assert.deepEqual(result.calls, [
    ["queue", false],
    ["store-items", [42, 43, 44]],
    ["ignore", 42],
    ["ignore", 43],
  ]);
});

test("queue exhaustion delivers Steam's summary sentinel instead of an empty queue", async () => {
  const result = await runPrefilter({
    queueBodies: [encodeQueueResponse([42]), encodeQueueResponse([])],
    successfulIgnores: [42],
    matchingAppIds: [42],
  });
  assert.deepEqual(result.appIds, [1]);
  assert.deepEqual(result.calls, [
    ["queue", false],
    ["store-items", [42]],
    ["ignore", 42],
    ["queue", true],
  ]);
});

test("background preview responses pass through without loading or ignoring", async () => {
  const body = encodeQueueResponse([42]);
  const result = await runPrefilter({
    dialogPresent: false,
    queueBodies: [body],
    successfulIgnores: [42],
    matchingAppIds: [42],
  });
  assert.deepEqual(result.appIds, [42]);
  assert.deepEqual(result.calls, [
    ["queue", false],
    ["store-items", [42]],
  ]);
  assert.deepEqual(result.body, body);
  assert.strictEqual(result.response, result.initialResponse);
});
