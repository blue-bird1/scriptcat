// ==UserScript==
// @name         Digiphile Steam Key Helper
// @namespace    https://github.com/blue-bird1/scriptcat
// @version      1.0.0
// @description  在 Digiphile 库中批量刮开或读取所选 Steam Key，复制 Key 或标题与 Key，不激活 Steam
// @author       blue-bird1
// @match        https://www.digiphile.co/customer/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      api.digiphile.co
// @run-at       document-idle
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/blue-bird1/scriptcat/main/digiphile-steam-keys.user.js
// @updateURL    https://raw.githubusercontent.com/blue-bird1/scriptcat/main/digiphile-steam-keys.user.js
// ==/UserScript==

import { startDigiphileSteamKeys } from "../lib/digiphile/steam-keys.js";

startDigiphileSteamKeys();
