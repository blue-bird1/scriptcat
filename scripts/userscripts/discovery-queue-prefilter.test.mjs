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

const DISCOVERY_QUEUE_DATA_REQUEST = {
  include_assets: true,
  include_trailers: true,
  include_basic_info: true,
  include_tag_count: 20,
  include_release: true,
  include_platforms: true,
  include_screenshots: true,
};

async function runPrefilter({ dialogPresent, ignoreSucceeds }) {
  const appIds = [42];
  const calls = [];
  const originalGlobals = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    location: globalThis.location,
    localStorage: globalThis.localStorage,
    window: globalThis.window,
  };
  const storeItemCache = {
    QueueMultipleAppRequests() {
      calls.push("store-items");
      return Promise.resolve(1);
    },
  };
  const originalFetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.steampowered.com/")) {
      calls.push("queue-response");
      return new Response(Uint8Array.from([0x0a, 0x01, 0x2a]), {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    assert.equal(url, "/recommended/ignorerecommendation");
    assert.equal(init?.method, "POST");
    calls.push("ignore");
    return Response.json({ success: ignoreSucceeds ? 1 : 2 });
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
    StoreItemCache: storeItemCache,
    fetch: originalFetch,
    g_sessionID: "session",
  };

  const stop = startDiscoveryQueuePrefilter({
    async getStoreItem(appId) {
      return { appId: Number(appId), success: 1, isFree: true };
    },
  });
  try {
    await storeItemCache.QueueMultipleAppRequests(
      appIds,
      DISCOVERY_QUEUE_DATA_REQUEST,
    );
    return { appIds, calls };
  } finally {
    stop();
    globalThis.document = originalGlobals.document;
    globalThis.HTMLElement = originalGlobals.HTMLElement;
    globalThis.location = originalGlobals.location;
    globalThis.localStorage = originalGlobals.localStorage;
    globalThis.window = originalGlobals.window;
  }
}

test("queue delivery waits for successful prefiltering and keeps failed ignores", async () => {
  const succeeded = await runPrefilter({ dialogPresent: true, ignoreSucceeds: true });
  assert.deepEqual(succeeded.appIds, []);
  assert.deepEqual(succeeded.calls, ["store-items", "ignore"]);

  const failed = await runPrefilter({ dialogPresent: true, ignoreSucceeds: false });
  assert.deepEqual(failed.appIds, [42]);
  assert.deepEqual(failed.calls, ["store-items", "ignore"]);
});

test("matching background StoreItem batches pass through without a queue dialog", async () => {
  const background = await runPrefilter({
    dialogPresent: false,
    ignoreSucceeds: true,
  });
  assert.deepEqual(background.appIds, [42]);
  assert.deepEqual(background.calls, ["store-items"]);
});
