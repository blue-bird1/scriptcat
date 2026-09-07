// ==UserScript==
// @name               Z-Library local owned mark
// @name:zh-CN         Z-Library 本地已有标注
// @namespace          out
// @version            2026.9.8.11
// @description        Mark Z-Library cards owned locally by title and author
// @description:zh-CN  按书名和作者标注本地已有的 Z-Library 书籍卡片
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

/* global $, ZLibraryModal, ZLibraryNotify */

import { startZlibLocalOwnedMark } from "../lib/zlib/local-owned-mark.js";

startZlibLocalOwnedMark();
