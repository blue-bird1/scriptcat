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

(() => {
  // src/lib/douban/auth.js
  function getCkValue() {
    const cookieValue = document.cookie.split("; ").find((row) => row.startsWith("ck="))?.split("=")[1];
    return cookieValue || "";
  }

  // src/lib/douban/series.js
  function ignoreUiException() {
    return false;
  }
  function openDoulistDialogNoOverride(sid, title, picture) {
    try {
      const options = {
        cate: "1001",
        catename: "图书",
        title: title || (document.querySelector("h1") && document.querySelector("h1").textContent || document.title),
        url: location.href,
        picture: picture || "",
        canview: "True",
        id: sid
      };
      $().doulistDialog({ ...options });
    } catch (e) {
      console.error("打开豆列对话框失败", e);
      alert("打开豆列对话框失败，详情见控制台");
    }
  }
  function injectDoulistButtonOnSeries() {
    if (!location.pathname.match(/\/series\//)) return;
    if (document.querySelectorAll(".doulist-add-btn-custom").length > 0) return;
    const items = document.querySelectorAll("li.subject-item");
    if (!items.length) return;
    items.forEach((item) => {
      if (item.querySelector(".doulist-add-btn-custom")) return;
      const titleEl = item.querySelector(".info h2 a");
      const title = titleEl ? titleEl.textContent.trim() : "";
      const imgEl = item.querySelector(".pic img");
      const picture = imgEl ? imgEl.getAttribute("src") : "";
      const sid = titleEl.getAttribute("href").match(/\/subject\/(\d+)\//)?.[1];
      const cartActions = item.querySelector(".cart-actions");
      if (!cartActions) return;
      const cartInfo = cartActions.querySelector(".cart-info");
      if (!cartInfo) return;
      const btn = document.createElement("div");
      btn.className = "doulist-add-btn-custom";
      btn.style.display = "inline-block";
      btn.style.marginLeft = "8px";
      const link = document.createElement("a");
      link.href = "javascript:void(0);";
      link.className = "lnk-doulist-add-custom";
      link.innerHTML = "添加到书单";
      link.style.color = "#42BD56";
      link.style.textDecoration = "none";
      link.style.cursor = "pointer";
      link.style.display = "inline-flex";
      link.style.alignItems = "center";
      link.addEventListener("click", function(e) {
        e.preventDefault();
        openDoulistDialogNoOverride(sid, title, picture);
      });
      btn.appendChild(link);
      if (cartInfo.nextSibling) {
        cartActions.insertBefore(btn, cartInfo.nextSibling);
      } else {
        cartActions.appendChild(btn);
      }
    });
  }
  function updateBookStatus(subjectId, status) {
    return new Promise((resolve) => {
      const ck = getCkValue();
      if (!subjectId || !status || !ck) {
        resolve(false);
        return;
      }
      const url = `https://book.douban.com/j/subject/${subjectId}/interest`;
      const referrer = `https://book.douban.com/subject/${subjectId}/`;
      const formData = new FormData();
      formData.append("interest", status);
      formData.append("rating", "");
      formData.append("foldcollect", "F");
      formData.append("tags", "");
      formData.append("comment", "");
      formData.append("ck", ck);
      const encodedData = new URLSearchParams(formData).toString();
      GM_xmlhttpRequest({
        method: "POST",
        url,
        headers: {
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "Referer": referrer,
          "X-Requested-With": "XMLHttpRequest"
        },
        data: encodedData,
        onload: function(response) {
          try {
            const result = JSON.parse(response.responseText);
            resolve(result.r === 0);
          } catch (e) {
            console.error("解析响应失败:", e);
            resolve(false);
          }
        },
        onerror: function() {
          console.error("请求失败");
          resolve(false);
        }
      });
    });
  }
  function extractSubjectIds() {
    const ids = /* @__PURE__ */ new Set();
    document.querySelectorAll("li.subject-item").forEach((li) => {
      const a = li.querySelector("a.nbg") || li.querySelector("h2 a");
      if (!a) return;
      const href = a.getAttribute("href") || "";
      let m = href.match(/\/subject\/(\d+)\//);
      if (m) {
        ids.add(m[1]);
        return;
      }
      const onclick = a.getAttribute("onclick") || "";
      m = onclick.match(/subject_id:'(\d+)'/);
      if (m) ids.add(m[1]);
    });
    return Array.from(ids);
  }
  async function markSubjectsAsRead(ids, progress) {
    if (!ids || ids.length === 0) return { success: 0, total: 0 };
    let success = 0;
    let ownProgress = null;
    try {
      if (!progress) {
        ownProgress = createProgressBar("批量标记为读过...");
        progress = ownProgress;
      }
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        try {
          const ok = await updateBookStatus(id, "collect");
          console.log(`标记 ${id} -> ${ok ? "成功" : "失败"}`);
          if (ok) success++;
        } catch (e) {
          console.error("标记出错", id, e);
        }
        try {
          progress.update(i + 1, ids.length);
        } catch {
          ignoreUiException();
        }
        await new Promise((r) => setTimeout(r, 800));
      }
    } finally {
      if (ownProgress) try {
        ownProgress.close();
      } catch {
        ignoreUiException();
      }
    }
    return { success, total: ids.length };
  }
  function createFloatingButton(options) {
    if (!options || !options.id) return null;
    if (document.getElementById(options.id)) return document.getElementById(options.id);
    const btn = document.createElement("button");
    btn.id = options.id;
    btn.textContent = options.text || "";
    btn.style.position = "fixed";
    btn.style.right = "20px";
    btn.style.bottom = typeof options.bottom === "number" ? options.bottom + "px" : "20px";
    btn.style.zIndex = "9999";
    btn.style.padding = "8px 12px";
    btn.style.background = options.background || "#ccc";
    btn.style.border = "none";
    btn.style.borderRadius = "4px";
    btn.style.cursor = "pointer";
    btn.style.boxShadow = "0 2px 6px rgba(0,0,0,0.08)";
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      try {
        btn.disabled = true;
        await options.onClick && options.onClick(btn);
      } catch (e) {
        console.error(`按钮 ${options.id} 回调出错`, e);
        alert("操作出现错误，详情见控制台");
      } finally {
        btn.disabled = false;
      }
    });
    document.body.appendChild(btn);
    return btn;
  }
  function createBulkReadButton() {
    createFloatingButton({
      id: "douban-bulk-read-btn",
      text: "批量标记本页为读过",
      bottom: 20,
      background: "#ffda44",
      onClick: async () => {
        const ids = extractSubjectIds();
        if (!ids.length) {
          alert("未找到任何书籍项");
          return;
        }
        if (!await confirmDialog(`检测到 ${ids.length} 本书，确定全部标记为“读过”吗？`)) return;
        const res = await markSubjectsAsRead(ids);
        alert(`完成：${res.success}/${res.total} 标记成功`);
      }
    });
  }
  function createBulkReadAllPagesButton() {
    createFloatingButton({
      id: "douban-bulk-read-allpages-btn",
      text: "全部标记读过",
      bottom: 60,
      background: "#8bd46e",
      onClick: async () => {
        if (!await confirmDialog("将尝试抓取系列各页并标记为读过，确认继续？")) return;
        const collectProgress = createProgressBar("抓取系列页面...");
        const ids = await collectAllSeriesSubjectIds(50, 600, collectProgress);
        collectProgress.close();
        if (!ids.length) {
          alert("未找到任何书籍");
          return;
        }
        if (!await confirmDialog(`检测到 ${ids.length} 本书，确定全部标记为“读过”吗？`)) return;
        const markProgress = createProgressBar("批量标记为读过...");
        const res = await markSubjectsAsRead(ids, markProgress);
        markProgress.close();
        alert(`完成：${res.success}/${res.total} 标记成功`);
      }
    });
  }
  function createZlibCheckButton() {
    createFloatingButton({
      id: "douban-zlib-check-btn",
      text: "检测本页 Z-Lib 可下载情况",
      bottom: 100,
      background: "#4fc3f7",
      onClick: async () => {
        await detectZlibForCurrentPage({ delayMs: 700 });
      }
    });
  }
  function findLatestDoulistDialog() {
    const candidates = document.querySelectorAll('[id^="dui-dialog"]');
    if (!candidates.length) return null;
    let latest = candidates[0];
    let maxNum = parseInt((latest.id || "").replace(/\D/g, ""), 10) || 0;
    for (let i = 1; i < candidates.length; i++) {
      const n = parseInt((candidates[i].id || "").replace(/\D/g, ""), 10) || 0;
      if (n > maxNum) {
        maxNum = n;
        latest = candidates[i];
      }
    }
    return $(latest);
  }
  async function startDoulistDialog() {
    createFloatingButton({
      id: "douban-doulist-dialog-btn",
      text: "添加丛书到豆列",
      bottom: 140,
      background: "#ff9800",
      onClick: async () => {
        try {
          const options = {
            cate: "1001",
            catename: "图书",
            title: document.querySelector("#content > h1").textContent,
            url: location.href
          };
          $().doulistDialog({ ...options });
          const dialogNode = findLatestDoulistDialog();
          if (!dialogNode || !dialogNode.length) {
            console.error("未找到豆列对话框节点");
            return;
          }
          const frm = dialogNode.find("form");
          frm.off("submit");
          frm.on("submit", async function(e) {
            e.preventDefault();
            var doulistSelect = frm.find("input[name=dl_id]:checked");
            var doulistId = doulistSelect.val();
            const collectProgress = createProgressBar("抓取系列页面...");
            const ids = await collectAllSeriesSubjectIds(50, 600, collectProgress);
            collectProgress.close();
            if (!ids.length) {
              alert("未找到任何书籍");
              return;
            }
            if (!doulistId) {
              alert("请选择一个豆列");
              return;
            }
            if (!await confirmDialog(`检测到 ${ids.length} 本书，确定全部添加到豆列吗？`)) return;
            const requestUrl = `https://book.douban.com/j/doulist/${doulistId}/additem`;
            const addProgress = createProgressBar("添加到豆列中...");
            for (let i = 0; i < ids.length; i++) {
              const id = ids[i];
              const itemOptions = {
                sid: id,
                skind: 1001,
                ck: getCkValue(),
                comment: ""
              };
              await new Promise((resolve) => {
                GM_xmlhttpRequest({
                  method: "POST",
                  url: requestUrl,
                  headers: {
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
                  },
                  data: new URLSearchParams(itemOptions).toString(),
                  onload: function(response) {
                    try {
                      const result = JSON.parse(response.responseText);
                      console.log(`添加 ${id} -> ${result.r === 0 ? "成功" : "失败"}`);
                    } catch (e2) {
                      console.error("解析响应失败:", e2);
                    }
                    resolve();
                  },
                  onerror: function() {
                    console.error("请求失败");
                    resolve();
                  }
                });
              });
              try {
                addProgress.update(i + 1, ids.length);
              } catch {
                ignoreUiException();
              }
            }
            addProgress.close();
            var obj = {
              __title: "收藏丛书成功",
              __action: "收藏丛书成功"
            };
            dialogNode.trigger("dialog-success", obj);
          });
        } catch (e) {
          console.error("启动豆列对话框失败", e);
          alert("启动豆列对话框失败，详情见控制台");
        }
      }
    });
  }
  function getSeriesBaseUrl() {
    const url = new URL(location.href);
    const pathname = url.pathname.replace(/\/$/, "");
    return `${url.origin}${pathname}`;
  }
  function fetchPageHtml(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: { "Accept": "text/html" },
        onload: function(res) {
          if (res.status >= 200 && res.status < 300) resolve(res.responseText);
          else reject(new Error("HTTP " + res.status));
        },
        onerror: function(e) {
          reject(e);
        }
      });
    });
  }
  function extractSubjectIdsFromHtml(html) {
    const ids = /* @__PURE__ */ new Set();
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      doc.querySelectorAll("li.subject-item").forEach((li) => {
        const a = li.querySelector("a.nbg") || li.querySelector("h2 a");
        if (!a) return;
        const href = a.getAttribute("href") || "";
        let m = href.match(/\/subject\/(\d+)\//);
        if (m) {
          ids.add(m[1]);
          return;
        }
        const onclick = a.getAttribute("onclick") || "";
        m = onclick.match(/subject_id:'(\d+)'/);
        if (m) ids.add(m[1]);
      });
    } catch (e) {
      console.error("解析 HTML 失败", e);
    }
    return Array.from(ids);
  }
  async function collectAllSeriesSubjectIds(maxPages = 50, pageDelay = 600, progress) {
    const base = getSeriesBaseUrl();
    const allIds = /* @__PURE__ */ new Set();
    let ownProgress = null;
    try {
      if (!progress) {
        ownProgress = createProgressBar("抓取系列页面...");
        progress = ownProgress;
      }
      for (let p = 1; p <= maxPages; p++) {
        const url = `${base}${p === 1 ? "" : "?page=" + p}`;
        console.log("抓取系列页：", url);
        try {
          const html = await fetchPageHtml(url);
          const ids = extractSubjectIdsFromHtml(html);
          if (!ids.length) {
            console.log("第", p, "页未发现书目，停止抓取");
            break;
          }
          ids.forEach((id) => allIds.add(id));
          try {
            progress.update(p, maxPages);
          } catch {
            ignoreUiException();
          }
          await new Promise((r) => setTimeout(r, pageDelay));
        } catch (e) {
          console.error("抓取或解析页出错，停止：", e);
          break;
        }
      }
    } finally {
      if (ownProgress) try {
        ownProgress.close();
      } catch {
        ignoreUiException();
      }
    }
    return Array.from(allIds);
  }
  async function fetchBookIsbn(subjectId) {
    if (!subjectId) return "";
    const url = `https://book.douban.com/subject/${subjectId}/`;
    try {
      const html = await fetchPageHtml(url);
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const infoEl = doc.getElementById("info");
      const text = infoEl ? infoEl.textContent : doc.body.textContent || "";
      const m = text.match(/ISBN(?:\s*13)?(?:\s*：|:)\s*([0-9Xx-]{8,})/);
      if (m && m[1]) return m[1].replace(/-/g, "").trim();
      const m2 = text.match(/ISBN[^0-9A-Za-z]*([0-9Xx-]{8,})/);
      if (m2 && m2[1]) return m2[1].replace(/-/g, "").trim();
    } catch (e) {
      console.error("fetchBookIsbn 失败", subjectId, e);
    }
    return "";
  }
  async function checkZlibByIsbn(isbn) {
    if (!isbn) return null;
    const url = `https://zh.1lib.sk/s/${encodeURIComponent(isbn)}?e=1`;
    try {
      const html = await fetchPageHtml(url);
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const card = doc.querySelector("#searchResultBox > div.resItemBoxBooks > z-bookcard");
      if (card) {
        let href = card.getAttribute("href");
        if (href) href = href.trim();
        if (href && href.startsWith("/")) href = "https://zh.1lib.sk" + href;
        let dlUrl = card.getAttribute("download");
        if (dlUrl) dlUrl = dlUrl.trim();
        if (dlUrl && dlUrl.startsWith("/")) dlUrl = "https://zh.1lib.sk" + dlUrl;
        if (href || dlUrl) {
          return { href, dlUrl };
        }
      }
      return null;
    } catch (e) {
      console.error("checkZlibByIsbn 失败", isbn, e);
      return null;
    }
  }
  function markLiDownloadable(subjectId, liElement, zlibData) {
    try {
      let li = liElement;
      if (!li) {
        li = Array.from(document.querySelectorAll("li.subject-item")).find((item) => {
          const a = item.querySelector("a.nbg") || item.querySelector("h2 a");
          if (!a) return false;
          const href = a.getAttribute("href") || "";
          if (href.includes(`/subject/${subjectId}/`)) return true;
          const onclick = a.getAttribute("onclick") || "";
          return onclick.includes(`'${subjectId}'`);
        });
      }
      if (!li) return;
      if (!li.classList.contains("zlib-available")) {
        li.classList.add("zlib-available");
        li.style.boxShadow = "0 0 0 3px rgba(63,191,63,0.08)";
        li.style.border = "1px solid #3fbf3f";
        const h2 = li.querySelector("h2") || li.querySelector(".info h2");
        if (h2) {
          const tag = document.createElement("span");
          tag.textContent = " Z-Lib 可下载";
          tag.style.color = "#2a8f2a";
          tag.style.fontWeight = "600";
          tag.style.marginLeft = "6px";
          h2.appendChild(tag);
        }
      }
      if (zlibData) {
        let linkContainer = li.querySelector(".zlib-link-container");
        if (!linkContainer) {
          linkContainer = document.createElement("div");
          linkContainer.className = "zlib-link-container";
          linkContainer.style.marginTop = "6px";
          const ft = li.querySelector(".ft") || li.querySelector(".info");
          if (ft) ft.appendChild(linkContainer);
          else li.appendChild(linkContainer);
        }
        const links = [
          zlibData.dlUrl && {
            url: zlibData.dlUrl,
            text: "⬇ 直接下载",
            className: "zlib-direct-download",
            bgColor: "bg-green-500"
          },
          zlibData.href && {
            url: zlibData.href,
            text: "⤓ 详情页",
            className: "zlib-detail-page",
            bgColor: "bg-green-500"
          }
        ].filter(Boolean);
        links.forEach((link) => {
          if (!Array.from(linkContainer.querySelectorAll("a")).some((a) => a.href === link.url)) {
            const btn = document.createElement("a");
            btn.href = link.url;
            btn.target = "_blank";
            btn.rel = "noopener noreferrer";
            btn.textContent = link.text;
            btn.className = `${link.className} inline-block px-2 py-1 mr-1.5 ${link.bgColor} text-white rounded text-xs font-bold no-underline`;
            linkContainer.appendChild(btn);
          }
        });
      }
    } catch (e) {
      console.error("markLiDownloadable 失败", subjectId, e);
    }
  }
  function createProgressBar(title = "处理中...") {
    const container = document.createElement("div");
    container.id = "progress-container";
    container.className = "fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white p-5 rounded-lg shadow-lg z-[10000] min-w-[300px]";
    const titleEl = document.createElement("div");
    titleEl.textContent = title;
    titleEl.className = "font-bold mb-3 text-sm";
    const progressBar = document.createElement("div");
    progressBar.className = "w-full h-1.5 bg-gray-200 rounded-full overflow-hidden";
    const progressFill = document.createElement("div");
    progressFill.className = "h-full bg-gradient-to-r from-cyan-400 to-green-500 w-0 transition-all duration-300";
    progressBar.appendChild(progressFill);
    const statsEl = document.createElement("div");
    statsEl.className = "mt-2.5 text-xs text-gray-500 text-center";
    container.appendChild(titleEl);
    container.appendChild(progressBar);
    container.appendChild(statsEl);
    document.body.appendChild(container);
    return {
      container,
      progressFill,
      statsEl,
      update(current, total) {
        const percent = Math.round(current / total * 100);
        progressFill.style.width = percent + "%";
        statsEl.textContent = `${current} / ${total}`;
      },
      close() {
        container.remove();
      }
    };
  }
  async function detectZlibForCurrentPage(options = { delayMs: 700 }) {
    const ids = extractSubjectIds();
    if (!ids.length) {
      alert("未找到本页书籍项");
      return;
    }
    const isConfirm = await confirmDialog(`将依次查询 ${ids.length} 本书），继续？`);
    if (!isConfirm) {
      console.log("用户取消 Z-Lib 检测");
      return;
    }
    const progress = createProgressBar("检测 Z-Lib 可下载情况...");
    let found = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      progress.update(i + 1, ids.length);
      try {
        const isbn = await fetchBookIsbn(id);
        if (!isbn) {
          console.log(`未获取到 ISBN：${id}`);
        } else {
          const zlibData = await checkZlibByIsbn(isbn);
          console.log(`Z-Lib 检测 ${id} (${isbn}) -> ${zlibData ? JSON.stringify(zlibData) : "无结果"}`);
          if (zlibData) {
            markLiDownloadable(id, null, zlibData);
            found++;
          }
        }
      } catch (e) {
        console.error("检测出错", id, e);
      }
      await new Promise((r) => setTimeout(r, options.delayMs));
    }
    progress.close();
    alert(`检测完成：共找到 ${found} 本可在 Z-Lib 下载`);
  }
  var dialog_js_url = "https://img1.doubanio.com/f/vendors/f25ae221544f39046484a823776f3aa01769ee10/js/ui/dialog.js";
  var dialog_css_url = "https://img1.doubanio.com/f/vendors/e8a7261937da62636d22ca4c579efc4a4d759b1b/css/ui/dialog.css";
  var doulist_dialog_js_url = "https://img1.doubanio.com/f/vendors/c9ec72017e551cf6dd9ea9a6b7610d579c4dbf91/js/sns/doulist_dialog.js";
  var doulist_dialog_css_url = "https://img1.doubanio.com/f/vendors/e8b3d08f6633abe019772aa5b069b62b00f02cc2/css/sns/new_doulist_button.css";
  var tailwindcss_url = "https://cdn.tailwindcss.com";
  function loadScript(url) {
    return new Promise(
      (resolve, reject) => {
        const script = document.createElement("script");
        script.src = url;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
        document.head.appendChild(script);
      }
    );
  }
  function loadCSS(url) {
    return new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = url;
      link.onload = () => resolve();
      link.onerror = () => reject(new Error(`Failed to load CSS: ${url}`));
      document.head.appendChild(link);
    });
  }
  async function preloadDialogResources() {
    try {
      await loadCSS(dialog_css_url);
      await loadCSS(doulist_dialog_css_url);
      await loadScript(dialog_js_url);
      await loadScript(doulist_dialog_js_url);
      await loadScript(tailwindcss_url);
      console.log("资源加载完成");
    } catch (e) {
      console.error("资源加载失败", e);
    }
  }
  async function confirmDialog(content = "确定要继续吗？", title = "确认") {
    return new Promise((resolve) => {
      try {
        const contentEl = document.createElement("div");
        contentEl.className = "px-4 py-3 text-sm text-gray-700";
        contentEl.innerHTML = content;
        const buttonContainer = document.createElement("div");
        buttonContainer.className = "flex justify-end gap-3 px-4  border-t border-gray-200 bg-gray-50";
        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "取消";
        cancelBtn.id = "cancel-btn";
        cancelBtn.className = "px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 active:bg-gray-100 transition";
        const confirmBtn = document.createElement("button");
        confirmBtn.textContent = "确认";
        confirmBtn.id = "confirm-btn";
        confirmBtn.className = "px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 active:bg-blue-800 transition";
        buttonContainer.appendChild(cancelBtn);
        buttonContainer.appendChild(confirmBtn);
        const fullContent = document.createElement("div");
        fullContent.appendChild(contentEl);
        fullContent.appendChild(buttonContainer);
        const dialog = new dui.Dialog({
          title,
          content: fullContent,
          width: 400,
          hasClose: true
        }).open();
        dialog.update();
        dialog.node.bind("dialog:close", function() {
          dialog.node.remove();
          resolve(false);
        });
        dialog.node.bind("dialog:change", function() {
          dialog.update();
        });
        dialog.node.find("#confirm-btn").on("click", function() {
          console.log("dialog:confirm");
          resolve(true);
          dialog.close();
        });
        dialog.node.find("#cancel-btn").on("click", function() {
          dialog.close();
          resolve(false);
        });
      } catch (e) {
        console.error("confirmDialog 失败", e);
        resolve(confirm(title + "\n\n" + content));
      }
    });
  }
  function startDoubanSeriesEnhancement() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", injectDoulistButtonOnSeries);
    } else {
      injectDoulistButtonOnSeries();
    }
    try {
      createZlibCheckButton();
      createBulkReadAllPagesButton();
      createBulkReadButton();
      preloadDialogResources().then(() => startDoulistDialog()).catch((e) => {
        console.error("预加载对话框资源出错", e);
      });
    } catch (e) {
      console.error("初始化按钮失败", e);
    }
  }

  // src/userscripts/douban.user.js
  startDoubanSeriesEnhancement();
})();
