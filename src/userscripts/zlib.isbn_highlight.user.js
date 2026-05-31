// ==UserScript==
// @name         Z-Library highlight missing ISBN Book
// @name:zh-CN   高亮Z-Library上 缺失 ISBN 的 bookcard
// @namespace    out
// @version      2025.12.28
// @description  高亮那些没有 isbn 属性或 isbn 为空的 z-bookcard 元素
// @author       blue-bird
// @match        https://*.z-library.sk/*
// @match        https://*.z-lib.fm/*
// @match        https://*.z-lib.gs/book/*
// @match        https://*.z-lib.gs/booklist/*
// @match        https://*.z-lib.gs/
// @match        https://*.z-lib.gs/s/*
// @match        https://*.z-lib.gs/users/downloads
// @match        https://*.z-lib.gs/users/zrecommended*
// @match        https://*.1lib.sk/book/*
// @match        https://*.1lib.sk/booklist/*
// @match        https://*.1lib.sk/
// @match        https://*.1lib.sk/s/*
// @match        https://*.1lib.sk/users/downloads
// @match        https://*.1lib.sk/users/zrecommended*
// @run-at       document-end
// @grant        GM_addStyle
// ==/UserScript==

import { startZlibIsbnHighlight } from "../lib/zlib/bookcard-isbn.js";

startZlibIsbnHighlight();
