import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeDiscoveryQueueAppIds,
  isDiscoveryQueueRebuildRequest,
} from "../../src/lib/steam/discovery-queue-prefilter.js";

// Captured protobuf wire fixtures from Steam's IStoreService discovery-queue contract.
const REBUILD_STANDARD_QUEUE = "CAAYAQ=="; // queue_type = 0, rebuild_queue = true
const REBUILD_PREVIEW_QUEUE = "CAAYAA=="; // queue_type = 0, rebuild_queue = false
const REBUILD_OTHER_QUEUE = "CAEYARgB"; // queue_type = 1, rebuild_queue = true

test("only Steam's standard rebuild queue protobuf request is eligible", () => {
  assert.equal(isDiscoveryQueueRebuildRequest(REBUILD_STANDARD_QUEUE), true);
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
