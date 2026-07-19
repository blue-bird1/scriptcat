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

(() => {
  // src/lib/steam/discovery-queue.js
  var QUEUE_TIMEOUT_MS = 1e4;
  var ADVANCE_DELAY_MS = 250;
  function isVisible(element) {
    return Boolean(
      element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden"
    );
  }
  function matchesAction(target, selector) {
    return target instanceof Element && target.closest(selector) !== null;
  }
  function startSteamDiscoveryQueue() {
    if (new URLSearchParams(location.search).get("queue") !== "1") {
      return () => {
      };
    }
    const queueActions = document.querySelector("#queueActionsCtn");
    const nextButton = document.querySelector(
      "#nextInDiscoveryQueue .btn_next_in_queue_trigger"
    );
    if (!(queueActions instanceof HTMLElement) || !(nextButton instanceof HTMLElement)) {
      return () => {
      };
    }
    let observer;
    let timer;
    const pendingActions = /* @__PURE__ */ new Set();
    let advancing = false;
    function stopWaiting() {
      observer?.disconnect();
      observer = void 0;
      clearTimeout(timer);
      timer = void 0;
      pendingActions.clear();
    }
    function advance() {
      stopWaiting();
      advancing = true;
      timer = setTimeout(() => {
        requestAnimationFrame(() => {
          const currentNextButton = document.querySelector(
            "#nextInDiscoveryQueue .btn_next_in_queue_trigger"
          );
          if (currentNextButton instanceof HTMLElement) {
            currentNextButton.click();
          }
          advancing = false;
        });
      }, ADVANCE_DELAY_MS);
    }
    function hasSucceeded(action) {
      if (action === "wishlist") {
        return isVisible(document.querySelector("#add_to_wishlist_area_success")) && !isVisible(document.querySelector("#add_to_wishlist_area_fail"));
      }
      return isVisible(document.querySelector(".queue_btn_ignore .queue_btn_active")) && !isVisible(document.querySelector(".queue_btn_ignore .queue_btn_inactive"));
    }
    function hasFailed(action) {
      return action === "wishlist" && isVisible(document.querySelector("#add_to_wishlist_area_fail"));
    }
    function checkResults() {
      for (const action of pendingActions) {
        if (hasSucceeded(action)) {
          advance();
          return;
        }
        if (hasFailed(action)) {
          pendingActions.delete(action);
        }
      }
      if (pendingActions.size === 0) {
        stopWaiting();
      }
    }
    function waitForResult(action) {
      if (advancing) {
        return;
      }
      pendingActions.add(action);
      if (observer) {
        return;
      }
      observer = new MutationObserver(checkResults);
      observer.observe(queueActions, {
        attributes: true,
        attributeFilter: ["class", "style"],
        childList: true,
        subtree: true
      });
      timer = setTimeout(stopWaiting, QUEUE_TIMEOUT_MS);
    }
    function handleClick(event) {
      const { target } = event;
      if (matchesAction(target, "#add_to_wishlist_area a.add_to_wishlist")) {
        waitForResult("wishlist");
      } else if (matchesAction(target, ".queue_btn_ignore .queue_btn_inactive") || matchesAction(target, "#queue_ignore_menu_option_not_interested") || matchesAction(target, "#queue_ignore_menu_option_owned_elsewhere")) {
        waitForResult("ignore");
      }
    }
    function stop() {
      stopWaiting();
      queueActions.removeEventListener("click", handleClick, true);
      window.removeEventListener("pagehide", stop);
    }
    queueActions.addEventListener("click", handleClick, true);
    window.addEventListener("pagehide", stop, { once: true });
    return stop;
  }

  // src/userscripts/steam-discovery-queue.user.js
  startSteamDiscoveryQueue();
})();
