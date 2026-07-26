import assert from "node:assert/strict";
import test from "node:test";

import {
  parseBatchCsv,
  preflightBatch,
  submitBatch,
} from "../../src/lib/steampy/steampy-plus-seller-batch.js";
import {
  createSteampyXbootClient,
  STEAMPY_XBOOT_LOG_PREFIX,
} from "../../src/lib/steampy/xboot-client.js";
import { gmXhr } from "../../src/lib/userscript/gm-xhr.js";

test("GM transport failures preserve the complete callback response", async () => {
  const transportResponse = {
    status: 0,
    statusText: "Network Error",
    finalUrl: "https://steampy.com/xboot/steamKeySale/startSell",
    responseHeaders: "",
    responseText: "",
  };

  await assert.rejects(
    gmXhr({}, (request) => request.onerror(transportResponse)),
    (error) => {
      assert.equal(error.message, "网络请求失败");
      assert.equal(error.response, transportResponse);
      return true;
    },
  );
});

test("startSell sends one native form request and logs the complete failed exchange", async () => {
  const requests = [];
  const logs = [];
  const response = {
    status: 200,
    finalUrl: "https://steampy.com/xboot/steamKeySale/startSell",
    responseHeaders: "content-type: application/json",
    responseText: '{"success":false,"code":500,"message":"failed"}',
    response: { success: false, code: 500, message: "failed" },
  };
  const client = createSteampyXbootClient({
    getAccessToken: () => "local-access-token",
    logger: {
      log(...args) {
        logs.push(args);
      },
      error(...args) {
        logs.push(args);
      },
    },
    async sendRequest(request) {
      requests.push(request);
      return response;
    },
  });

  await assert.rejects(
    client.startKeySale({
      gameId: "748400107661037568",
      keys: "469PB-BXXBM-8E3TN",
      sellPrice: 8.08,
    }),
    { message: "业务请求失败：failed" },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "https://steampy.com/xboot/steamKeySale/startSell");
  assert.equal(requests[0].headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(requests[0].headers.accesstoken, "local-access-token");
  assert.equal(
    requests[0].data,
    "gameId=748400107661037568&keys=469PB-BXXBM-8E3TN&keyWord=&sellPrice=8.08&syncUs=0",
  );
  assert.equal(logs[0][0], `${STEAMPY_XBOOT_LOG_PREFIX} request`);
  assert.equal(logs[0][1], requests[0]);
  assert.equal(logs[1][0], `${STEAMPY_XBOOT_LOG_PREFIX} response`);
  assert.equal(logs[1][1].request, requests[0]);
  assert.equal(logs[1][1].response, response);
});

test("CSV contract rejects key-only rows and preserves quoted fields and large IDs", () => {
  const input = [
    "ONLY-A-KEY",
    '  "Game, Deluxe" , AAAAA-BBBBB-CCCCC, 2276930, 748400107661037568',
  ].join("\n");

  const result = parseBatchCsv(input);

  assert.deepEqual(
    result.errors.map(({ code, lineNumber, rawLine }) => ({ code, lineNumber, rawLine })),
    [{ code: "field-count", lineNumber: 1, rawLine: "ONLY-A-KEY" }],
  );
  assert.deepEqual(result.rows[0], {
    lineNumber: 2,
    rawLine: '  "Game, Deluxe" , AAAAA-BBBBB-CCCCC, 2276930, 748400107661037568',
    gameName: "Game, Deluxe",
    key: "AAAAA-BBBBB-CCCCC",
    appId: "2276930",
    gameId: "748400107661037568",
  });
  assert.equal(typeof result.rows[0].gameId, "string");
});

test("CSV contract reports duplicate keys without discarding source rows", () => {
  const input = [
    "Game A,AAAAA-BBBBB-CCCCC",
    "Game B,AAAAA-BBBBB-CCCCC",
  ].join("\n");

  const result = parseBatchCsv(input);

  assert.deepEqual(
    result.errors.map(({ code, lineNumber }) => ({ code, lineNumber })),
    [{ code: "duplicate-key", lineNumber: 2 }],
  );
  assert.deepEqual(result.rows.map(({ lineNumber, key }) => ({ lineNumber, key })), [
    { lineNumber: 1, key: "AAAAA-BBBBB-CCCCC" },
    { lineNumber: 2, key: "AAAAA-BBBBB-CCCCC" },
  ]);
});

test("preflight resolves the current region and uses the first fresh listing price", async () => {
  const calls = [];
  const rows = parseBatchCsv(",AAAAA-BBBBB-CCCCC,2276930").rows;
  const client = {
    async fetchSaleKeyByUrl(url, region) {
      calls.push(["url", url, region]);
      return {
        result: {
          content: [{
            appId: "2276930",
            gameName: "Chillquarium",
            id: "748400107661037568",
          }],
        },
      };
    },
    async fetchSaleKeyByName() {
      assert.fail("appId resolution must not call name search");
    },
    async fetchKeySaleList(options) {
      calls.push(["list", options]);
      return {
        content: [
          { keyPrice: "63.95" },
          { keyPrice: "64.00" },
        ],
      };
    },
  };

  const result = await preflightBatch(rows, { client, region: "tl" });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(calls, [
    ["url", "https://store.steampowered.com/app/2276930/", "tl"],
    ["list", { gameId: "748400107661037568", region: "tl" }],
  ]);
  assert.deepEqual(result.groups.map(({ appId, gameId, gameName, keyPrice, keys }) => ({
    appId,
    gameId,
    gameName,
    keyPrice,
    keys,
  })), [{
    appId: "2276930",
    gameId: "748400107661037568",
    gameName: "Chillquarium",
    keyPrice: "63.95",
    keys: ["AAAAA-BBBBB-CCCCC"],
  }]);
});

test("preflight rejects an appId and explicit gameId mismatch", async () => {
  const rows = parseBatchCsv("Chillquarium,AAAAA-BBBBB-CCCCC,2276930,111111111111111111").rows;
  const client = {
    async fetchSaleKeyByUrl() {
      return { result: { content: [{ id: "748400107661037568" }] } };
    },
    async fetchSaleKeyByName() {
      assert.fail("explicit IDs must not fall back to name search");
    },
    async fetchKeySaleList() {
      assert.fail("conflicting identifiers must not query a price");
    },
  };

  const result = await preflightBatch(rows, { client, region: "cn" });

  assert.deepEqual(
    result.errors.map(({ code, lineNumber }) => ({ code, lineNumber })),
    [{ code: "resolve", lineNumber: 1 }],
  );
  assert.deepEqual(result.groups, []);
});

test("submission uses each group price, continues ordinary failures, and stops on token invalidation", async () => {
  const calls = [];
  let tokenInvalid = false;
  const groups = [
    {
      gameId: "111111111111111111",
      keyPrice: "1.25",
      keys: ["KEY-A"],
      rows: [{ lineNumber: 1, rawLine: "Game A,KEY-A" }],
    },
    {
      gameId: "222222222222222222",
      keyPrice: "2.50",
      keys: ["KEY-B"],
      rows: [{ lineNumber: 2, rawLine: "Game B,KEY-B" }],
    },
    {
      gameId: "333333333333333333",
      keyPrice: "3.75",
      keys: ["KEY-C"],
      rows: [{ lineNumber: 3, rawLine: "Game C,KEY-C" }],
    },
  ];
  const client = {
    isTokenInvalid() {
      return tokenInvalid;
    },
    async startKeySale(payload) {
      calls.push(payload);
      if (payload.gameId === groups[0].gameId) throw new Error("ordinary rejection");
      tokenInvalid = true;
      throw new Error("token expired");
    },
  };

  const result = await submitBatch(groups, { client, region: "us" });

  assert.deepEqual(calls, [
    {
      region: "us",
      gameId: "111111111111111111",
      keys: "KEY-A",
      sellPrice: "1.25",
    },
    {
      region: "us",
      gameId: "222222222222222222",
      keys: "KEY-B",
      sellPrice: "2.50",
    },
  ]);
  assert.deepEqual(result.results.map(({ ok, gameId, rawLines }) => ({ ok, gameId, rawLines })), [
    { ok: false, gameId: "111111111111111111", rawLines: ["Game A,KEY-A"] },
    { ok: false, gameId: "222222222222222222", rawLines: ["Game B,KEY-B"] },
  ]);
  assert.equal(result.stopped, true);
  assert.deepEqual(result.pendingGroups, [groups[2]]);
});
