// ==UserScript==
// @name         豆瓣丛书增强
// @namespace    https://github.com/yourname/scriptcat
// @version      0.2.0
// @description  针对豆瓣丛书页的批量操作脚本
// @author       GitHub Copilot
// @match        https://book.douban.com/series/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      book.douban.com
// @connect      zh.1lib.sk
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

/* global $, dui */

import { startDoubanSeriesEnhancement } from "../lib/douban/series.js";

startDoubanSeriesEnhancement();
