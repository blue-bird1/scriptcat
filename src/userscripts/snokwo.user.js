// ==UserScript==
// @name            Sonkwo Steam AppID提取器
// @name:zh-CN      Sonkwo Steam AppID提取器
// @name:en         Sonkwo Steam AppID extractor
// @namespace       https://github.com/blue-bird1/scriptcat
// @version         0.1.1
// @description     从 Sonkwo 商店搜索页提取游戏 Steam AppID，并可在 SteamPy 相关流程中复用
// @description:en  Extract Steam AppIDs from Sonkwo store search pages for later use with SteamPy workflows
// @author          blue-bird1
// @match           https://www.sonkwo.hk/store/search*
// @match           https://steampy.com/*
// @grant           GM_xmlhttpRequest
// @grant           GM_setValue
// @grant           GM_getValue
// @grant           GM_listValues
// @grant           GM_deleteValue
// @grant           GM_registerMenuCommand
// @require         https://scriptcat.org/lib/637/1.4.8/ajaxHooker.js#sha256=dTF50feumqJW36kBpbf6+LguSLAtLr7CEs3oPmyfbiM=
// @connect         www.sonkwo.hk
// @connect         steampy.com
// @license         MIT
// ==/UserScript==

/* global ajaxHooker */

import { startSnokwoSearchPrice } from "../lib/sonkwo/search-price.js";

startSnokwoSearchPrice();
