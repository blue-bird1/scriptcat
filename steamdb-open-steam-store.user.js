// ==UserScript==
// @name         SteamDB 中键点击打开 Steam 商店
// @name:zh-CN   SteamDB 中键点击打开 Steam 商店
// @name:en      Middle-click SteamDB to open the Steam store
// @namespace    https://github.com/blue-bird1/scriptcat
// @version      1.0.1
// @description  在 SteamDB 即时搜索与促销列表中键点击游戏条目，打开对应 Steam 商店页
// @description:en Middle-click game entries in SteamDB instant search and sales lists to open the Steam store page
// @author       blue-bird1
// @match        https://steamdb.info/instantsearch/*
// @match        https://steamdb.info/sales/*
// @icon         https://steamdb.info/favicon.ico
// @grant        none
// @run-at       document-idle
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/blue-bird1/scriptcat/main/steamdb-open-steam-store.user.js
// @updateURL    https://raw.githubusercontent.com/blue-bird1/scriptcat/main/steamdb-open-steam-store.user.js
// ==/UserScript==

(() => {
  // src/lib/steamdb/open-steam-store.js
  var LOG_ID = "steamdb-open-steam-store";
  var STEAM_APP_URL = "https://store.steampowered.com/app/";
  function logEvent(level, event, fields) {
    console[level]({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      id: LOG_ID,
      level,
      event,
      ...fields
    });
  }
  function parseAppId(value) {
    if (typeof value !== "string") {
      return null;
    }
    const appId = value.trim();
    return /^\d+$/.test(appId) ? appId : null;
  }
  function resolveSteamAppId(target) {
    const element = target instanceof Element ? target : target?.parentElement;
    if (!(element instanceof Element)) {
      return null;
    }
    const hitItem = element.closest("li.ais-Hits-item");
    if (hitItem) {
      return parseAppId(hitItem.querySelector("a[data-appid]")?.getAttribute("data-appid"));
    }
    const saleRow = element.closest("table.table-sales tr[data-appid]");
    if (saleRow) {
      return parseAppId(saleRow.getAttribute("data-appid"));
    }
    const appLink = element.closest("a.app[data-appid]");
    if (appLink) {
      return parseAppId(appLink.getAttribute("data-appid"));
    }
    return null;
  }
  function openSteamStore(appId) {
    const url = `${STEAM_APP_URL}${appId}/`;
    const tab = window.open(url, "_blank");
    if (tab) {
      logEvent("info", "steam_store_opened", { appId, url });
      return;
    }
    logEvent("error", "steam_store_popup_blocked", { appId, url });
  }
  function handlePointerEvent(event) {
    if (event.button !== 1) {
      return;
    }
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) {
      return;
    }
    const appId = resolveSteamAppId(event.target);
    if (!appId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "mousedown") {
      openSteamStore(appId);
    }
  }
  function startSteamdbOpenSteamStore() {
    document.addEventListener("mousedown", handlePointerEvent, true);
    document.addEventListener("auxclick", handlePointerEvent, true);
    logEvent("info", "script_started", { href: location.href });
  }

  // src/userscripts/steamdb-open-steam-store.user.js
  startSteamdbOpenSteamStore();
})();
