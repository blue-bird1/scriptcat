// ==UserScript==
// @name         GreenManGaming Bundle Claim Helper
// @namespace    https://github.com/blue-bird1/scriptcat
// @version      0.1.2
// @description  在 GreenManGaming Bundles 订单取码页复制 Steam key，并批量提交到 Steam 激活接口
// @author       blue-bird1
// @match        https://www.greenmangamingbundles.com/*/order-claim/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      store.steampowered.com
// @run-at       document-idle
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/blue-bird1/scriptcat/main/greenmangaming-bundle-claim.user.js
// @updateURL    https://raw.githubusercontent.com/blue-bird1/scriptcat/main/greenmangaming-bundle-claim.user.js
// ==/UserScript==

(() => {
  // src/lib/userscript/gm-xhr.js
  function gmXhr(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        timeout: 2e4,
        ...options,
        onload: resolve,
        onerror: () => reject(new Error("网络请求失败")),
        ontimeout: () => reject(new Error("网络请求超时"))
      });
    });
  }

  // src/lib/gmg/claim-helper.js
  var TOOLBAR_ID = "gmg-steam-claim-helper";
  var SESSION_ID_KEY = "gmgSteamClaimHelperSessionId";
  var KEY_PATTERN = /^(?:(?:([A-Z0-9])(?!\1{4})){5}-){2,5}[A-Z0-9]{5}$/;
  var ACTIVATION_DELAY_MS = 2e3;
  var STEAM_REGISTER_URL = "https://store.steampowered.com/account/ajaxregisterkey/";
  var STEAM_HOME_URL = "https://store.steampowered.com/";
  var STEAM_REGISTER_PAGE = "https://store.steampowered.com/account/registerkey";
  var RESULT_MESSAGES = {
    9: "已拥有",
    13: "地区限制",
    14: "无效 Key",
    15: "已被使用",
    24: "缺少基础游戏",
    36: "需要 PS3 激活",
    50: "钱包/礼品卡代码",
    53: "Steam 限速"
  };
  function startGmgBundleClaimHelper() {
    let activationRunning = false;
    let currentItems = [];
    let statusList = null;
    let statusSummary = null;
    let actionButtons = [];
    let lastDetectedKeySignature = "";
    let liveRegionCounter = 0;
    function sleep(ms) {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    }
    function normalizeKey(rawKey) {
      return String(rawKey || "").trim().toUpperCase();
    }
    function getItemTitle(itemNode) {
      const titleNode = itemNode.querySelector("h3");
      return titleNode ? titleNode.textContent.trim() : "";
    }
    function extractItems() {
      const seen = /* @__PURE__ */ new Set();
      const items = [];
      const itemNodes = Array.from(document.querySelectorAll("#keys-section .item-list"));
      itemNodes.forEach((itemNode) => {
        const keyButton = itemNode.querySelector(".copy-key-btn[data-key]");
        const key = normalizeKey(keyButton ? keyButton.dataset.key : "");
        if (!KEY_PATTERN.test(key) || seen.has(key)) {
          return;
        }
        seen.add(key);
        items.push({
          key,
          title: getItemTitle(itemNode),
          node: itemNode
        });
      });
      return items;
    }
    function keySignature(items) {
      return items.map((item) => item.key).join("\n");
    }
    function setNodeStatus(item, state, text) {
      item.node.dataset.gmgSteamClaimStatus = state;
      let badge = item.node.querySelector(".gmg-steam-claim-item-status");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "gmg-steam-claim-item-status";
        const titleNode = item.node.querySelector(".title h3") || item.node.querySelector("h3");
        if (titleNode) {
          titleNode.insertAdjacentElement("afterend", badge);
        }
      }
      if (badge) {
        badge.textContent = text;
        badge.dataset.status = state;
      }
    }
    function appendStatusLine(text, state) {
      if (!statusList) {
        return;
      }
      const line = document.createElement("li");
      line.textContent = text;
      line.dataset.status = state || "info";
      statusList.appendChild(line);
      statusList.scrollTop = statusList.scrollHeight;
    }
    function updateSummary(text) {
      if (statusSummary && statusSummary.textContent !== text) {
        statusSummary.textContent = text;
      }
      const liveRegion = document.querySelector("#copy-live-region[aria-live]");
      if (liveRegion) {
        liveRegionCounter += 1;
        liveRegion.textContent = `${text} ${liveRegionCounter}`;
      }
    }
    async function copyText(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        try {
          await navigator.clipboard.writeText(text);
          return;
        } catch (error) {
          console.warn("[GMG Steam Claim Helper] navigator.clipboard failed, fallback to execCommand.", error);
        }
      }
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "readonly");
      textarea.style.position = "fixed";
      textarea.style.top = "-1000px";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) {
        throw new Error("浏览器拒绝写入剪贴板");
      }
    }
    async function copyKeys(includeTitles) {
      const items = extractItems();
      if (items.length === 0) {
        updateSummary("没有找到 Steam key");
        return;
      }
      const text = items.map((item) => {
        return includeTitles ? `${item.title}	${item.key}` : item.key;
      }).join("\n");
      try {
        await copyText(text);
        updateSummary(`已复制 ${items.length} 个 Steam key`);
      } catch (error) {
        updateSummary(`复制失败：${error.message}`);
      }
    }
    function parseSessionId(responseText) {
      const accountMatch = responseText.match(/g_AccountID = (\d+)/);
      const sessionMatch = responseText.match(/g_sessionID = "(\w+)"/);
      const accountId = accountMatch ? Number(accountMatch[1]) : 0;
      const sessionId = sessionMatch ? sessionMatch[1] : "";
      if (accountId > 0 && sessionId) {
        return sessionId;
      }
      return "";
    }
    async function refreshSessionId() {
      updateSummary("正在从 Steam 获取 sessionid...");
      try {
        const response = await gmXhr({
          method: "GET",
          url: STEAM_HOME_URL
        });
        if (response.status !== 200) {
          throw new Error(`Steam 首页返回 HTTP ${response.status}`);
        }
        const sessionId = parseSessionId(response.responseText || response.response || "");
        if (!sessionId) {
          throw new Error("未检测到已登录的 Steam 账号");
        }
        GM_setValue(SESSION_ID_KEY, sessionId);
        updateSummary("Steam sessionid 已更新");
        return sessionId;
      } catch (error) {
        updateSummary(`获取 sessionid 失败：${error.message}`);
        throw error;
      }
    }
    function getSavedSessionId() {
      return String(GM_getValue(SESSION_ID_KEY, "") || "").trim();
    }
    function describeResult(result) {
      if (result.success === 1) {
        return "激活成功";
      }
      const detailCode = Number(result.purchase_result_details);
      return RESULT_MESSAGES[detailCode] || `失败：${detailCode || "未知原因"}`;
    }
    async function activateKey(item, sessionId) {
      const data = new URLSearchParams({
        product_key: item.key,
        sessionid: sessionId
      }).toString();
      const response = await gmXhr({
        method: "POST",
        url: STEAM_REGISTER_URL,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Origin: "https://store.steampowered.com",
          Referer: STEAM_REGISTER_PAGE
        },
        data
      });
      if (response.status !== 200) {
        throw new Error(`Steam 激活接口返回 HTTP ${response.status}`);
      }
      try {
        return JSON.parse(response.responseText || response.response || "{}");
      } catch (error) {
        throw new Error(`Steam 返回不是 JSON：${error.message}`);
      }
    }
    function summarizeCounts(counts, total) {
      return `已处理 ${counts.done}/${total}，成功 ${counts.success}，已拥有 ${counts.owned}，已用 ${counts.used}，无效 ${counts.invalid}，失败 ${counts.failed}`;
    }
    function applyResultCounts(counts, result) {
      counts.done += 1;
      if (result.success === 1) {
        counts.success += 1;
        return "success";
      }
      const detailCode = Number(result.purchase_result_details);
      if (detailCode === 9) {
        counts.owned += 1;
        return "owned";
      }
      if (detailCode === 15) {
        counts.used += 1;
        return "used";
      }
      if (detailCode === 14) {
        counts.invalid += 1;
        return "invalid";
      }
      counts.failed += 1;
      return "failed";
    }
    function setControlsDisabled(disabled) {
      actionButtons.forEach((button) => {
        button.disabled = disabled;
      });
    }
    async function activateAll() {
      if (activationRunning) {
        return;
      }
      currentItems = extractItems();
      if (currentItems.length === 0) {
        updateSummary("没有找到可激活的 Steam key");
        return;
      }
      activationRunning = true;
      setControlsDisabled(true);
      statusList.textContent = "";
      let sessionId = getSavedSessionId();
      if (!sessionId) {
        try {
          sessionId = await refreshSessionId();
        } catch (error) {
          appendStatusLine(`无法开始激活：${error.message}`, "failed");
          activationRunning = false;
          setControlsDisabled(false);
          return;
        }
      }
      const counts = {
        done: 0,
        success: 0,
        owned: 0,
        used: 0,
        invalid: 0,
        failed: 0
      };
      updateSummary(`开始激活 ${currentItems.length} 个 Steam key`);
      for (const item of currentItems) {
        setNodeStatus(item, "working", "激活中");
        try {
          const result = await activateKey(item, sessionId);
          const state = applyResultCounts(counts, result);
          const message = describeResult(result);
          setNodeStatus(item, state, message);
          appendStatusLine(`${item.title || item.key}: ${message}`, state);
          updateSummary(summarizeCounts(counts, currentItems.length));
          if (Number(result.purchase_result_details) === 53) {
            appendStatusLine("Steam 返回限速，已停止后续激活。", "failed");
            break;
          }
        } catch (error) {
          counts.done += 1;
          counts.failed += 1;
          setNodeStatus(item, "failed", "请求失败");
          appendStatusLine(`${item.title || item.key}: ${error.message}`, "failed");
          updateSummary(summarizeCounts(counts, currentItems.length));
        }
        if (counts.done < currentItems.length) {
          await sleep(ACTIVATION_DELAY_MS);
        }
      }
      activationRunning = false;
      setControlsDisabled(false);
      appendStatusLine("队列结束", "info");
    }
    function createButton(text, handler) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gmg-steam-claim-button";
      button.textContent = text;
      button.addEventListener("click", handler);
      actionButtons.push(button);
      return button;
    }
    function createToolbar() {
      const toolbar = document.createElement("section");
      toolbar.id = TOOLBAR_ID;
      const title = document.createElement("h3");
      title.textContent = "Steam Key 工具";
      const controls = document.createElement("div");
      controls.className = "gmg-steam-claim-controls";
      controls.append(
        createButton("复制全部 Key", () => {
          copyKeys(false);
        }),
        createButton("复制标题 + Key", () => {
          copyKeys(true);
        }),
        createButton("刷新 Session", () => {
          refreshSessionId().catch((error) => {
            appendStatusLine(error.message, "failed");
          });
        }),
        createButton("激活全部", () => {
          activateAll();
        })
      );
      statusSummary = document.createElement("p");
      statusSummary.className = "gmg-steam-claim-summary";
      statusList = document.createElement("ul");
      statusList.className = "gmg-steam-claim-status-list";
      toolbar.append(title, controls, statusSummary, statusList);
      return toolbar;
    }
    function renderToolbar() {
      if (document.getElementById(TOOLBAR_ID)) {
        currentItems = extractItems();
        const nextSignature = keySignature(currentItems);
        if (!activationRunning && nextSignature !== lastDetectedKeySignature) {
          lastDetectedKeySignature = nextSignature;
          updateSummary(`检测到 ${currentItems.length} 个 Steam key`);
        }
        return;
      }
      const keysSection = document.querySelector("#keys-section");
      if (!keysSection) {
        return;
      }
      actionButtons = [];
      const toolbar = createToolbar();
      const anchor = keysSection.querySelector(".item-list-wrapper") || keysSection.firstElementChild;
      if (anchor) {
        anchor.insertAdjacentElement("beforebegin", toolbar);
      } else {
        keysSection.prepend(toolbar);
      }
      currentItems = extractItems();
      lastDetectedKeySignature = keySignature(currentItems);
      updateSummary(`检测到 ${currentItems.length} 个 Steam key`);
    }
    function installObserver() {
      const target = document.querySelector("#keys-content") || document.body;
      const observer = new MutationObserver((mutations) => {
        const toolbar = document.getElementById(TOOLBAR_ID);
        const onlyToolbarMutations = toolbar && mutations.every((mutation) => {
          return toolbar.contains(mutation.target);
        });
        if (onlyToolbarMutations) {
          return;
        }
        renderToolbar();
      });
      observer.observe(target, {
        childList: true,
        subtree: true
      });
    }
    GM_addStyle(`
        #gmg-steam-claim-helper {
            margin: 0 0 16px;
            padding: 14px;
            border: 1px solid #d5dde4;
            border-radius: 8px;
            background: #ffffff;
            color: #1f2933;
            box-shadow: 0 1px 4px rgba(15, 23, 42, 0.12);
        }
        #gmg-steam-claim-helper h3 {
            margin: 0 0 10px;
            font-size: 18px;
            line-height: 1.3;
        }
        .gmg-steam-claim-controls {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 10px;
        }
        .gmg-steam-claim-button {
            min-height: 34px;
            padding: 6px 12px;
            border: 1px solid #0f766e;
            border-radius: 6px;
            background: #0f766e;
            color: #ffffff;
            font-size: 14px;
            line-height: 1.2;
            cursor: pointer;
        }
        .gmg-steam-claim-button:hover {
            background: #115e59;
        }
        .gmg-steam-claim-button:disabled {
            border-color: #94a3b8;
            background: #94a3b8;
            cursor: wait;
        }
        .gmg-steam-claim-summary {
            min-height: 20px;
            margin: 0 0 8px;
            font-size: 14px;
        }
        .gmg-steam-claim-status-list {
            max-height: 180px;
            margin: 0;
            padding-left: 20px;
            overflow: auto;
            font-size: 13px;
            line-height: 1.5;
        }
        .gmg-steam-claim-status-list li[data-status="success"],
        .gmg-steam-claim-item-status[data-status="success"] {
            color: #047857;
        }
        .gmg-steam-claim-status-list li[data-status="owned"],
        .gmg-steam-claim-status-list li[data-status="used"],
        .gmg-steam-claim-item-status[data-status="owned"],
        .gmg-steam-claim-item-status[data-status="used"] {
            color: #b45309;
        }
        .gmg-steam-claim-status-list li[data-status="failed"],
        .gmg-steam-claim-status-list li[data-status="invalid"],
        .gmg-steam-claim-item-status[data-status="failed"],
        .gmg-steam-claim-item-status[data-status="invalid"] {
            color: #b91c1c;
        }
        .gmg-steam-claim-item-status {
            display: inline-block;
            margin-top: 6px;
            font-size: 13px;
            font-weight: 700;
        }
    `);
    renderToolbar();
    installObserver();
  }

  // src/userscripts/greenmangaming-bundle-claim.user.js
  startGmgBundleClaimHelper();
})();
