// ==UserScript==
// @name         KeyLol SteamPY 价格及总价显示
// @version      1.8
// @description  在Keylol帖子显示Steam游戏的SteamPY CDKey价格，并计算每个引用块内的总价
// @author       bluebird
// @match        https://keylol.com/t*
// @match        https://keylol.com/forum.php?mod=viewthread*
// @match        https://steampy.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      steampy.com
// @connect      keylol.com
// @connect      store.steampowered.com
// @run-at       document-end
// @icon         https://steampy.com/m_logo.ico
// @license      MIT
// @namespace    https://greasyfork.org/users/
// ==/UserScript==

import { startKeylolSteampyPrice } from "../lib/keylol/steampy-price.js";

startKeylolSteampyPrice();
