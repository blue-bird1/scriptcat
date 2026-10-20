// ==UserScript==
// @name         Digiphile Steam Key Helper
// @namespace    https://github.com/blue-bird1/scriptcat
// @version      1.1.0
// @description  批量读取、复制和激活 Digiphile Steam Key
// @author       blue-bird1
// @match        https://www.digiphile.co/customer/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      api.digiphile.co
// @connect      store.steampowered.com
// @run-at       document-idle
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/blue-bird1/scriptcat/main/digiphile-steam-keys.user.js
// @updateURL    https://raw.githubusercontent.com/blue-bird1/scriptcat/main/digiphile-steam-keys.user.js
// ==/UserScript==

import { startDigiphileSteamKeys } from "../lib/digiphile/steam-keys.js";

startDigiphileSteamKeys();
