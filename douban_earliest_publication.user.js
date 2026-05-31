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

(() => {
  // src/lib/douban/earliest-publication.js
  function findOtherVersions() {
    const versions = [];
    let container = document.querySelector("div.gray_ad.version_works");
    if (!container) {
      console.log("未找到其他版本容器（div.gray_ad.version_works）");
      return versions;
    }
    let items = Array.from(container.querySelectorAll("li.mb8.pl"));
    console.log(`初步在页面找到 ${items.length} 个版本条目`);
    let worksLinkEl = null;
    let totalCount = null;
    const heading = container.querySelector("h2");
    if (heading) {
      worksLinkEl = heading.querySelector('a[href*="/works/"]') || heading.querySelector("a");
      if (worksLinkEl && worksLinkEl.textContent) {
        const m = worksLinkEl.textContent.match(/全部\s*(\d+)/);
        if (m) totalCount = parseInt(m[1], 10);
      }
    }
    if (!worksLinkEl) {
      worksLinkEl = container.querySelector('a[href*="/works/"]');
    }
    const needFetchWorks = totalCount !== null ? totalCount > 4 : false;
    if (needFetchWorks) {
      if (worksLinkEl && worksLinkEl.href) {
        try {
          console.log("需要获取全部版本（依据标题总数或条目数量判断），开始 fetch works 页面：", worksLinkEl.href);
          const resp = fetch(worksLinkEl.href, { credentials: "include" });
          return resp.then((r) => {
            if (!r.ok) {
              console.warn("无法获取 works 页面", r.status);
              return parseItems(items);
            }
            return r.text().then((html) => {
              const parser = new DOMParser();
              const doc = parser.parseFromString(html, "text/html");
              const entryNodes = Array.from(doc.querySelectorAll("div.bkses.clearfix"));
              const candidates = [];
              const seen = /* @__PURE__ */ new Set();
              for (const node of entryNodes) {
                try {
                  const a = node.querySelector(".bkdesc a.pl2") || node.querySelector('a[href*="/subject/"]');
                  const href = a ? a.href : null;
                  if (!href || seen.has(href)) continue;
                  const bkdesc = node.querySelector(".bkdesc");
                  let year = null;
                  if (bkdesc) {
                    const spans = Array.from(bkdesc.querySelectorAll("span.pl"));
                    for (const s of spans) {
                      const label = (s.textContent || "").trim().replace(/\s+/g, "");
                      if (label.indexOf("出版年") !== -1) {
                        let next = s.nextSibling;
                        let txt = "";
                        if (next) {
                          if (next.nodeType === Node.TEXT_NODE) txt = next.nodeValue.trim();
                          else txt = (next.textContent || "").trim();
                        }
                        if (!txt) {
                          const el = s.nextElementSibling;
                          if (el) txt = (el.textContent || "").trim();
                        }
                        const m = txt.match(/(\d{4})/);
                        if (m) {
                          year = parseInt(m[1], 10);
                        }
                        break;
                      }
                    }
                  }
                  const desc = bkdesc ? bkdesc.textContent.trim().replace(/\s+/g, " ") : a ? a.textContent.trim() : "";
                  seen.add(href);
                  candidates.push({ text: desc, link: href, year: year || null });
                } catch {
                  continue;
                }
              }
              const merged = mergeVersionCandidates(items, candidates);
              console.log(`从 works 页面解析并合并后，共有 ${merged.length} 个版本`);
              return merged;
            });
          }).catch((err) => {
            console.warn("fetch works 页面失败：", err);
            return parseItems(items);
          });
        } catch (e) {
          console.warn("处理 works 页面时发生异常：", e);
        }
      } else {
        console.log("未找到 works 页面链接，使用当前页面列出的版本");
      }
    }
    return parseItems(items);
    function parseItems(nodeList) {
      const out = [];
      for (const li of nodeList) {
        try {
          const a = li.querySelector('a[href*="/subject/"]');
          const text = a ? (a.textContent || a.innerText || "").trim() : (li.textContent || "").trim();
          const yearMatch = text.match(/（(\d{4})）|（(\d{4})年/);
          const pm = text.match(/(\d{4})年|（(\d{4})）|(\d{4})/);
          const year = yearMatch ? parseInt(yearMatch[1] || yearMatch[2], 10) : pm ? parseInt(pm[1] || pm[2] || pm[3], 10) : null;
          const link = a ? a.href : null;
          if (year) {
            out.push({ text, year, link });
            console.log(`提取版本: ${text} (${year})`);
          }
        } catch {
          continue;
        }
      }
      return out;
    }
    function mergeVersionCandidates(currentItems, candidates) {
      const map = /* @__PURE__ */ new Map();
      for (const li of currentItems) {
        try {
          const a = li.querySelector && li.querySelector('a[href*="/subject/"]');
          const text = a ? (a.textContent || a.innerText || "").trim() : (li.textContent || "").trim();
          const yearMatch = text.match(/（(\d{4})）|（(\d{4})年/);
          const pm = text.match(/(\d{4})年|（(\d{4})）|(\d{4})/);
          const year = yearMatch ? parseInt(yearMatch[1] || yearMatch[2], 10) : pm ? parseInt(pm[1] || pm[2] || pm[3], 10) : null;
          const link = a ? a.href : null;
          if (link) map.set(link, { text, year, link });
          else if (text) map.set(text, { text, year, link });
        } catch {
          continue;
        }
      }
      for (const c of candidates) {
        if (!c.link && !c.text) continue;
        const key = c.link || c.text;
        if (!map.has(key)) {
          map.set(key, { text: c.text, year: c.year || null, link: c.link || null });
        }
      }
      return Array.from(map.values()).filter((v) => v && v.year);
    }
  }
  function findEarliestYear(versions) {
    if (!versions || versions.length === 0) return null;
    return Math.min(...versions.map((v) => v.year));
  }
  function findLatestYear(versions) {
    if (!versions || versions.length === 0) return null;
    return Math.max(...versions.map((v) => v.year));
  }
  function annotateEarliestPublicationYear(earliestYear, latestYear) {
    if (earliestYear === void 0) earliestYear = null;
    if (latestYear === void 0) latestYear = null;
    const infoEl = document.getElementById("info");
    if (!infoEl) {
      console.log("未找到 #info 元素");
      return false;
    }
    const infoText = infoEl.innerText || infoEl.textContent || "";
    const lines = infoText.split("\n").map((l) => l.trim()).filter(Boolean);
    let publicationLine = lines.find((l) => /出版年|出版時間|出版时间/.test(l));
    if (!publicationLine) {
      publicationLine = lines.find((l) => /\d{4}/.test(l));
    }
    if (!publicationLine) {
      console.log("未找到出版年信息");
      return false;
    }
    const yearMatch = publicationLine.match(/(\d{4})/);
    const currentYear = yearMatch ? parseInt(yearMatch[1], 10) : null;
    if (!currentYear && !earliestYear && !latestYear) {
      console.log("既无法从其他版本也无法从本页提取年份");
      return false;
    }
    const finalEarliest = currentYear && earliestYear ? Math.min(currentYear, earliestYear) : earliestYear || currentYear;
    const finalLatest = currentYear && latestYear ? Math.max(currentYear, latestYear) : latestYear || currentYear;
    let annotationDiv = document.getElementById("earliest-publication-annotation");
    if (!annotationDiv) {
      annotationDiv = document.createElement("div");
      annotationDiv.id = "earliest-publication-annotation";
      annotationDiv.style.marginTop = "8px";
      annotationDiv.style.padding = "8px";
      annotationDiv.style.background = "#fffacd";
      annotationDiv.style.border = "1px solid #f0e68c";
      annotationDiv.style.borderRadius = "4px";
      annotationDiv.style.fontSize = "12px";
      annotationDiv.style.color = "#333";
      annotationDiv.style.lineHeight = "1.6";
      infoEl.appendChild(annotationDiv);
    }
    const parts = [];
    if (finalEarliest && (!currentYear || currentYear > finalEarliest)) {
      parts.push(`<strong>💡 真正最早出版时间：</strong> ${finalEarliest}年`);
    }
    if (finalLatest) {
      if (currentYear) {
        const isLatest = currentYear >= finalLatest;
        if (isLatest) {
          parts.push("<strong>📌 是否最新版：</strong> 是");
        } else {
          parts.push(`<strong>📌 是否最新版：</strong> 否（最新版出版年：${finalLatest}年）`);
        }
      } else {
        parts.push(`<strong>📌 是否最新版：</strong> 当前页出版年未知（最新版出版年：${finalLatest}年）`);
      }
    }
    if (parts.length === 0) {
      return false;
    }
    annotationDiv.innerHTML = parts.join("<br>");
    console.log("已更新出版信息标注", { currentYear, earliestYear, latestYear, finalEarliest, finalLatest });
    return true;
  }
  async function runDoubanEarliestPublication() {
    try {
      console.log("=== 豆瓣图书最早出版时间标注脚本启动 ===");
      const subjectId = location.pathname.match(/\/subject\/(\d+)/);
      if (!subjectId) {
        console.log("不在图书页面");
        return;
      }
      console.log(`检测到图书 ID: ${subjectId[1]}`);
      const maybePromise = findOtherVersions();
      const versions = maybePromise && typeof maybePromise.then === "function" ? await maybePromise : maybePromise;
      const count = Array.isArray(versions) ? versions.length : 0;
      console.log(`找到 ${count} 个版本`);
      if (!versions || versions.length === 0) {
        console.log("未找到其他版本信息");
        return;
      }
      const earliestYear = findEarliestYear(versions);
      console.log(`最早出版年: ${earliestYear}`);
      if (!earliestYear) {
        console.log("无法提取年份信息");
        return;
      }
      const latestYear = findLatestYear(versions);
      console.log(`最晚出版年: ${latestYear}`);
      annotateEarliestPublicationYear(earliestYear, latestYear);
    } catch (e) {
      console.error("脚本执行出错:", e);
    }
  }
  function startDoubanEarliestPublication() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", runDoubanEarliestPublication);
    } else {
      runDoubanEarliestPublication();
    }
  }

  // src/userscripts/douban_earliest_publication.user.js
  startDoubanEarliestPublication();
})();
