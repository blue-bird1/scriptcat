import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeK900SaleStartedAt,
  formatK900SaleStartedAt,
  SALE_START_TIME_FALLBACK,
} from "../../src/lib/steampy/steampy-plus-sale-start-time.js";

const VERIFIED_SALE = Object.freeze({
  saleId: "K9001093910454993440768",
  serverCreateTime: "2026-07-27T05:01:57.343+08:00",
  displayedTime: "2026-07-27 05:01:57",
});

test("K900 saleId decodes to the verified server creation time", () => {
  assert.equal(decodeK900SaleStartedAt(VERIFIED_SALE.saleId), Date.parse(VERIFIED_SALE.serverCreateTime));
  assert.equal(formatK900SaleStartedAt(VERIFIED_SALE.saleId), VERIFIED_SALE.displayedTime);
  assert.equal(decodeK900SaleStartedAt("K9011093910454993440768"), null);
  assert.equal(formatK900SaleStartedAt(null), SALE_START_TIME_FALLBACK);
});
