// ==UserScript==
// @name         Steam Discovery Queue Auto Next
// @name:zh-CN   Steam 探索队列自动下一项
// @namespace    https://github.com/blue-bird1/scriptcat
// @version      0.1.0
// @description  愿望单或忽略成功后自动进入 Steam 探索队列下一项
// @author       blue-bird1
// @match        https://store.steampowered.com/app/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/blue-bird1/scriptcat/main/steam-discovery-queue.user.js
// @updateURL    https://raw.githubusercontent.com/blue-bird1/scriptcat/main/steam-discovery-queue.user.js
// ==/UserScript==

import { startSteamDiscoveryQueue } from "../lib/steam/discovery-queue.js";

startSteamDiscoveryQueue();
