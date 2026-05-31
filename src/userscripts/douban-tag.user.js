// ==UserScript==
// @name         豆瓣自动推荐书籍标签
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  提取网页内的推荐标签，放置到书籍详情和标签区域中，支持点击填充到标签输入框
// @author       blue-bird
// @match        https://book.douban.com/subject/*/
// @icon         https://www.google.com/s2/favicons?sz=64&domain=douban.com
// @grant        none
// @license      GPL
// ==/UserScript==

import { startDoubanTagRecommend } from "../lib/douban/tag-recommend.js";

startDoubanTagRecommend();
