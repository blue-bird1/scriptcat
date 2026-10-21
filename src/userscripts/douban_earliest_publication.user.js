// ==UserScript==
// @name         豆瓣图书最早出版时间标注
// @name:zh-CN   豆瓣图书最早出版时间标注
// @name:en      Douban earliest publication marker
// @namespace    https://github.com/blue-bird1/scriptcat
// @version      0.1.2
// @description  在豆瓣图书页面标注真正最早出版时间，并显示当前是否为最新版
// @description:en Mark the earliest publication date on Douban book pages and whether the current edition is the latest
// @author       blue-bird1
// @match        https://book.douban.com/subject/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

import { startDoubanEarliestPublication } from "../lib/douban/earliest-publication.js";

startDoubanEarliestPublication();
