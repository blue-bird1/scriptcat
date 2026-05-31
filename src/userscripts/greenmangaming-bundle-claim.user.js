// ==UserScript==
// @name         GreenManGaming Bundle Claim Helper
// @namespace    https://github.com/blue-bird1/scriptcat
// @version      0.1.2
// @description  在 GreenManGaming Bundles 订单取码页复制 Steam key，并批量提交到 Steam 激活接口
// @author       blue-bird1
// @match        https://www.greenmangamingbundles.com/*/order-claim/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      store.steampowered.com
// @run-at       document-idle
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/blue-bird1/scriptcat/main/greenmangaming-bundle-claim.user.js
// @updateURL    https://raw.githubusercontent.com/blue-bird1/scriptcat/main/greenmangaming-bundle-claim.user.js
// ==/UserScript==

import { startGmgBundleClaimHelper } from "../lib/gmg/claim-helper.js";

startGmgBundleClaimHelper();
