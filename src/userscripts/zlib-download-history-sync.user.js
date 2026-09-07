// ==UserScript==
// @name               Z-Library download history sync
// @name:zh-CN         Z-Library 多账号下载历史同步
// @namespace          out
// @version            2026.9.7
// @description        Collect and overwrite Z-Library localStorage.downloadedBooks across accounts
// @description:zh-CN  收集各账号 localStorage.downloadedBooks 到脚本存储，再覆盖回当前账号
// @author             blue-bird
// @match              https://*.z-library.sk/*
// @match              https://*.z-lib.fm/*
// @match              https://*.z-lib.gs/book/*
// @match              https://*.z-lib.gs/booklist/*
// @match              https://*.z-lib.gs/
// @match              https://*.z-lib.gs/s/*
// @match              https://*.z-lib.gs/users/downloads
// @match              https://*.z-lib.gs/users/zrecommended*
// @match              https://*.1lib.sk/book/*
// @match              https://*.1lib.sk/booklist/*
// @match              https://*.1lib.sk/
// @match              https://*.1lib.sk/s/*
// @match              https://*.1lib.sk/users/downloads
// @match              https://*.1lib.sk/users/zrecommended*
// @match              https://*.z-lib.gd/*
// @match              https://*.z-lib.gl/*
// @match              https://*.z-library.mn/*
// @run-at             document-end
// @grant              GM_getValue
// @grant              GM_setValue
// @grant              GM_registerMenuCommand
// @grant              GM_notification
// ==/UserScript==

/* global CurrentUser, ZLibraryNotify */

import { startZlibDownloadHistorySync } from "../lib/zlib/download-history-sync.js";

startZlibDownloadHistorySync();
