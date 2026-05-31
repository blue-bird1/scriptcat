// ==UserScript==
// @name         Sonkwo Steam AppID提取器
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  从Sonkwo商店搜索页面提取游戏的Steam AppID并保存
// @author       豆包编程助手
// @match        https://www.sonkwo.hk/store/search*
// @match        https://steampy.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @require      https://scriptcat.org/lib/637/1.4.8/ajaxHooker.js#sha256=dTF50feumqJW36kBpbf6+LguSLAtLr7CEs3oPmyfbiM=
// @connect      www.sonkwo.hk
// @connect      steampy.com
// ==/UserScript==

/* global ajaxHooker */

import { startSnokwoSearchPrice } from "../lib/sonkwo/search-price.js";

startSnokwoSearchPrice();
