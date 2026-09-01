import assert from "node:assert/strict";
import test from "node:test";

import { createSteamPyBuyerController } from "../../src/lib/steampy/steampy-plus-buyer.js";
import { createSteamPyRatingEnhancer } from "../../src/lib/steampy/steampy-plus-rating.js";

function createGameCard(appId) {
  const listeners = new Map();
  const card = {
    dataset: {},
    querySelector(selector) {
      if (selector === ".cdkGameIcon") {
        return { dataset: { src: `https://cdn.example/steam/apps/${appId}/header.jpg` } };
      }
      if (selector === ".gameName") {
        return { classList: { remove() {}, toggle() {} } };
      }
      return null;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event);
    },
  };
  return card;
}

test("hot presale cards do not shift middle-click targets in the CDKey sale grid", async (t) => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  const hotCards = [createGameCard(9001), createGameCard(9002)];
  const saleCards = [createGameCard(101), createGameCard(102), createGameCard(103)];
  const games = saleCards.map((_, index) => ({ appId: 101 + index }));
  const buyerElement = {
    querySelector(selector) {
      return selector === ".gameblock" ? saleCards[0] : null;
    },
    querySelectorAll(selector) {
      return selector === ".gameblock" ? saleCards : [];
    },
  };
  const vm = {
    $el: buyerElement,
    $nextTick(callback) {
      callback();
    },
    $watch() {
      return () => {};
    },
    gameList: games,
    getGameList() {},
    goToChoose() {},
    searchForm: { pageNumber: 1, pageSize: 30 },
    total: games.length,
  };
  const component = { proxy: vm, subTree: { el: buyerElement } };
  const app = { _vnode: { component } };

  globalThis.document = {
    querySelector(selector) {
      if (selector === "#app") return app;
      return null;
    },
    querySelectorAll(selector) {
      return selector === ".gameblock" ? [...hotCards, ...saleCards] : [];
    },
  };
  const opened = [];
  globalThis.window = {
    open(...args) {
      opened.push(args);
    },
  };

  const rating = createSteamPyRatingEnhancer({
    libraryManager: { getState: () => ({ wish: [] }) },
  });
  const buyer = createSteamPyBuyerController({
    advancedFilter: { cleanup() {}, mount() {} },
    elmGetter: { async get() {} },
    filter: { shouldShow: () => true },
    getValue: () => 30,
    jQuery: () => ({ get: () => [] }),
    rating,
    setValue() {},
  });

  await buyer.startPro();

  assert.equal(hotCards[0].dataset.steamPyPlusOpenBound, undefined);
  let prevented = false;
  saleCards[0].dispatch("mousedown", {
    button: 1,
    ctrlKey: false,
    preventDefault() {
      prevented = true;
    },
    shiftKey: false,
  });
  assert.equal(prevented, true);
  assert.deepEqual(opened, [["https://store.steampowered.com/app/101/", "_blank"]]);
});
