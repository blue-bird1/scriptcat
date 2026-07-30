import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeSteamPySaleStartedAt,
  formatSteamPySaleStartedAt,
  SALE_START_TIME_FALLBACK,
} from "../../src/lib/steampy/steampy-plus-sale-start-time.js";

const VERIFIED_PREFIXED_SALE = Object.freeze({
  saleId: "K9001093910454993440768",
  serverCreateTime: "2026-07-27T05:01:57.343+08:00",
  displayedTime: "2026-07-27 05:01:57",
});

const VERIFIED_UNPREFIXED_SALE = Object.freeze({
  saleId: "9000985793395086954496",
  serverCreateSecond: "2025-10-01T20:43:21+08:00",
  displayedTime: "2025-10-01 20:43:21",
});

test("verified SteamPy sale IDs decode to their server creation times", () => {
  assert.equal(
    decodeSteamPySaleStartedAt(VERIFIED_PREFIXED_SALE.saleId),
    Date.parse(VERIFIED_PREFIXED_SALE.serverCreateTime),
  );
  assert.equal(
    formatSteamPySaleStartedAt(VERIFIED_PREFIXED_SALE.saleId),
    VERIFIED_PREFIXED_SALE.displayedTime,
  );

  const unprefixedMilliseconds = decodeSteamPySaleStartedAt(VERIFIED_UNPREFIXED_SALE.saleId);
  assert.equal(
    Math.floor(unprefixedMilliseconds / 1000) * 1000,
    Date.parse(VERIFIED_UNPREFIXED_SALE.serverCreateSecond),
  );
  assert.equal(
    formatSteamPySaleStartedAt(VERIFIED_UNPREFIXED_SALE.saleId),
    VERIFIED_UNPREFIXED_SALE.displayedTime,
  );
});

test("unverified SteamPy sale ID families use the fallback", () => {
  for (const saleId of [
    "K9011093910454993440768",
    "K863728378853724160",
    "870831825876946944",
    null,
  ]) {
    assert.equal(decodeSteamPySaleStartedAt(saleId), null);
    assert.equal(formatSteamPySaleStartedAt(saleId), SALE_START_TIME_FALLBACK);
  }
});
