// ==UserScript==
// @name         SteamDB 中键点击打开 Steam 商店
// @name:zh-CN   SteamDB 中键点击打开 Steam 商店
// @namespace    https://github.com/blue-bird1/scriptcat
// @version      1.0.0
// @description  在 SteamDB 即时搜索与促销列表中键点击游戏条目，打开对应 Steam 商店页
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

import { startSteamdbOpenSteamStore } from "../lib/steamdb/open-steam-store.js";

startSteamdbOpenSteamStore();
