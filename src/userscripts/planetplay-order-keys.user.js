// ==UserScript==
// @name               PlanetPlay Order Key Helper
// @name:zh-CN         PlanetPlay 订单 Key 助手
// @name:en            PlanetPlay Order Key Helper
// @namespace          https://github.com/blue-bird1/scriptcat
// @version            1.0.1
// @description        自动提取 PlanetPlay 订单页已显示的 Key，支持批量复制游戏名与 Key、手动批量激活 Steam
// @description:zh-CN  自动提取 PlanetPlay 订单页已显示的 Key，支持批量复制游戏名与 Key、手动批量激活 Steam
// @description:en     Extract keys on PlanetPlay order pages; batch-copy names/keys and optionally activate on Steam
// @author             blue-bird1
// @match              https://planetplay.com/*/orders*
// @grant              GM_addStyle
// @grant              GM_setClipboard
// @grant              GM_xmlhttpRequest
// @connect            store.steampowered.com
// @run-at             document-idle
// @license            MIT
// @downloadURL        https://raw.githubusercontent.com/blue-bird1/scriptcat/main/planetplay-order-keys.user.js
// @updateURL          https://raw.githubusercontent.com/blue-bird1/scriptcat/main/planetplay-order-keys.user.js
// ==/UserScript==

import { startPlanetPlayOrderKeys } from "../lib/planetplay/order-keys.js";

startPlanetPlayOrderKeys();
