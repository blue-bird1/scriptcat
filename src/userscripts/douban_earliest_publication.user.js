// ==UserScript==
// @name         豆瓣图书最早出版时间标注
// @namespace    https://github.com/yourname/scriptcat
// @version      0.1.1
// @description  在豆瓣图书页面标注真正最早出版时间，并显示当前是否为最新版
// @author       GitHub Copilot
// @match        https://book.douban.com/subject/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

import { startDoubanEarliestPublication } from "../lib/douban/earliest-publication.js";

startDoubanEarliestPublication();
