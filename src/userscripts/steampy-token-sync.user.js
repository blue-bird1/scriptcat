// ==UserScript==
// @name         SteamPy Token Sync
// @name:zh-CN   SteamPy Token Sync
// @version      0.2.1
// @description  使用 ScriptCat 文件存储同步 SteamPy accessToken 与 Cookies，支持手动保存和覆盖当前浏览器登录态
// @author       bluebird
// @match        https://steampy.com/*
// @grant        CAT_fileStorage
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_cookie
// @grant        GM.cookie
// @connect      steampy.com
// @run-at       document-idle
// @icon         https://steampy.com/m_logo.ico
// @license      MIT
// @namespace    https://greasyfork.org/users/
// ==/UserScript==

/* global GM_cookie */

import { startSteampyTokenSync } from "../lib/steampy/token-sync.js";

startSteampyTokenSync();
