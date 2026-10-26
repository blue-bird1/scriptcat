import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";

import { createSteamPyPriceFilter } from "../../src/lib/steampy/steampy-plus-filter.js";

const FILTER_STORAGE_KEY = "steamPriceFilterState";

function installEnvironment(saved = {}) {
  const storage = { ...saved };
  const notifications = [];
  const menus = new Map();
  const { window } = parseHTML(`<!doctype html><html><head></head><body>
    <div class="toolbar">
      <div class="tag flex-row align-items-center"></div>
      <div class="searchCDK"></div>
    </div>
  </body></html>`);
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    GM_getValue: globalThis.GM_getValue,
    GM_setValue: globalThis.GM_setValue,
    GM_registerMenuCommand: globalThis.GM_registerMenuCommand,
    GM_notification: globalThis.GM_notification,
  };
  globalThis.document = window.document;
  globalThis.location = { href: "https://steampy.com/pro/cdKey/cdKey" };
  globalThis.GM_getValue = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : fallback
  );
  globalThis.GM_setValue = (key, value) => {
    storage[key] = value;
  };
  globalThis.GM_registerMenuCommand = (name, callback, options) => {
    menus.set(options.id, { name, callback });
  };
  globalThis.GM_notification = (payload) => {
    notifications.push(payload);
  };
  return {
    storage,
    notifications,
    menus,
    window,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

function libraryManager({ owned = [], ignored = [] } = {}) {
  const ownedIds = new Set(owned);
  const ignoredIds = new Set(ignored);
  return {
    isGameOwned: (appId) => ownedIds.has(Number(appId)),
    isGameIgnored: (appId) => ignoredIds.has(Number(appId)),
  };
}

function createFilter(env, manager, onApply = () => {}) {
  return createSteamPyPriceFilter({
    libraryManager: manager,
    onApply,
  });
}

test("hides owned games by default and when older settings omit the switch", (t) => {
  const env = installEnvironment();
  t.after(() => env.restore());
  const manager = libraryManager({ owned: [10], ignored: [30] });
  const filter = createFilter(env, manager);

  assert.equal(filter.hidesOwnedGames(), true);
  assert.equal(filter.shouldShow({ appId: 10, keyPrice: 12, steamApp: { type: "game" } }), false);
  assert.equal(filter.shouldShow({ appId: 20, keyPrice: 12, steamApp: { type: "game" } }), true);
  assert.equal(filter.shouldShow({ appId: 30, keyPrice: 12, steamApp: { type: "game" } }), false);

  env.restore();
  const legacy = installEnvironment({
    [FILTER_STORAGE_KEY]: JSON.stringify({ minPrice: 0, maxPrice: 9999, isActive: false, hideDlc: false }),
  });
  t.after(() => legacy.restore());
  const legacyFilter = createFilter(legacy, manager);
  assert.equal(legacyFilter.shouldShow({ appId: 10, keyPrice: 12 }), false);
});

test("showing owned games still applies price, DLC, and ignored filters", (t) => {
  const env = installEnvironment({
    [FILTER_STORAGE_KEY]: JSON.stringify({
      minPrice: 10,
      maxPrice: 20,
      isActive: true,
      hideDlc: true,
      hideOwned: false,
    }),
  });
  t.after(() => env.restore());
  const filter = createFilter(env, libraryManager({ owned: [10, 11, 12, 13], ignored: [12] }));

  assert.equal(filter.hidesOwnedGames(), false);
  assert.equal(filter.shouldShow({ appId: 10, keyPrice: 15, steamApp: { type: "game" } }), true);
  assert.equal(filter.shouldShow({ appId: 11, keyPrice: 15, steamApp: { type: "dlc" } }), false);
  assert.equal(filter.shouldShow({ appId: 12, keyPrice: 15, steamApp: { type: "game" } }), false);
  assert.equal(filter.shouldShow({ appId: 13, keyPrice: 9, steamApp: { type: "game" } }), false);
  assert.equal(filter.shouldShow({ appId: 14, keyPrice: 15, steamApp: { type: "game" } }), true);
});

test("filter bar and script menu share the persisted show or hide setting", (t) => {
  const env = installEnvironment();
  t.after(() => env.restore());
  let applied = 0;
  const filter = createFilter(env, libraryManager({ owned: [10] }), () => {
    applied += 1;
    filter.mount();
  });
  filter.registerMenus();
  filter.mount();

  const checkbox = env.window.document.getElementById("steamPyPlusHideOwned");
  const label = [...env.window.document.querySelectorAll("label")].find((node) => node.htmlFor === "steamPyPlusHideOwned");
  assert.equal(checkbox.checked, true);
  assert.equal(label.textContent, "隐藏已拥有");
  assert.equal(filter.shouldShow({ appId: 10, keyPrice: 12 }), false);
  assert.equal(env.menus.get("steam-py-plus-hide-owned").name, "已拥有游戏：隐藏（点击显示）");

  checkbox.checked = false;
  checkbox.dispatchEvent(new env.window.Event("change"));
  assert.equal(filter.hidesOwnedGames(), false);
  assert.equal(filter.shouldShow({ appId: 10, keyPrice: 12, steamApp: { type: "game" } }), true);
  assert.equal(checkbox.checked, false);
  assert.equal(JSON.parse(env.storage[FILTER_STORAGE_KEY]).hideOwned, false);
  assert.equal(env.menus.get("steam-py-plus-hide-owned").name, "已拥有游戏：显示（点击隐藏）");
  assert.equal(applied > 0, true);

  env.menus.get("steam-py-plus-hide-owned").callback();
  assert.equal(filter.hidesOwnedGames(), true);
  assert.equal(checkbox.checked, true);
  assert.equal(filter.shouldShow({ appId: 10, keyPrice: 12 }), false);
  assert.equal(env.notifications.at(-1).text, "CDKey 列表已隐藏已拥有游戏");
  assert.equal(env.menus.get("steam-py-plus-hide-owned").name, "已拥有游戏：隐藏（点击显示）");
});
