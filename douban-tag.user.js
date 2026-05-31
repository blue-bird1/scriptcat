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

(() => {
  // src/lib/douban/tag-recommend.js
  function extractKeywordsFromDoubanAdRequest() {
    const criteria = window.DoubanAdRequest && window.DoubanAdRequest.crtr || "";
    if (!criteria) {
      console.warn(" 未在 DoubanAdRequest 中找到标签信息！");
      return [];
    }
    const entries = criteria.split("|");
    return entries.filter((entry) => entry.startsWith("7:")).map((entry) => {
      const parts = entry.split(":");
      return parts.length > 1 ? parts[1] : null;
    }).filter(Boolean);
  }
  function addTagToInput(tag) {
    const tagInput = document.querySelector('input[name="tags"]');
    if (!tagInput) {
      console.warn("未找到标签输入框");
      return;
    }
    const currentValue = tagInput.value.trim();
    const existingTags = currentValue.split(/\s+/);
    if (existingTags.includes(tag)) {
      return;
    }
    tagInput.value = currentValue ? `${currentValue} ${tag}` : tag;
    tagInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function mountInfoSection(keywords) {
    const toggleButton = document.createElement("button");
    toggleButton.textContent = " 显示 / 隐藏 标签 ";
    toggleButton.style.marginBottom = "10px";
    toggleButton.style.padding = "5px 10px";
    toggleButton.style.cursor = "pointer";
    const keywordContainer = document.createElement("div");
    keywordContainer.style.display = "none";
    keywords.forEach((keyword) => {
      const link = document.createElement("a");
      link.href = `https://book.douban.com/tag/${encodeURIComponent(keyword)}`;
      link.textContent = keyword;
      link.target = "_blank";
      link.style.marginRight = "10px";
      link.style.textDecoration = "none";
      link.style.color = "#37a";
      link.addEventListener("click", () => {
        addTagToInput(keyword);
      });
      keywordContainer.appendChild(link);
    });
    toggleButton.addEventListener("click", () => {
      if (keywordContainer.style.display === "none") {
        keywordContainer.style.display = "block";
        toggleButton.textContent = " 隐藏 关键词 ";
      } else {
        keywordContainer.style.display = "none";
        toggleButton.textContent = " 显示 关键词 ";
      }
    });
    const infoElement = document.getElementById("info");
    if (infoElement) {
      infoElement.appendChild(toggleButton);
      infoElement.appendChild(keywordContainer);
    } else {
      console.warn(' 未找到 id 为 "info" 的元素！');
    }
  }
  function mountPopularTags(keywords) {
    let tagsAdded = false;
    function addTagsToPopularTags() {
      if (tagsAdded) return;
      const popularTags = document.getElementById("populartags");
      if (popularTags) {
        const dl = document.createElement("dl");
        const dt = document.createElement("dt");
        dt.textContent = " 流行标签:";
        dl.appendChild(dt);
        const dd = document.createElement("dd");
        keywords.forEach((keyword, index) => {
          const span = document.createElement("span");
          span.className = "tagbtn gract";
          span.textContent = keyword;
          span.addEventListener("click", () => {
            addTagToInput(keyword);
          });
          span.style.cursor = "pointer";
          dd.appendChild(span);
          if (index < keywords.length - 1) {
            span.style.marginRight = "8px";
          }
        });
        dl.appendChild(dd);
        popularTags.appendChild(dl);
        tagsAdded = true;
        return;
      }
      const observer = new MutationObserver(() => {
        if (document.getElementById("populartags")) {
          addTagsToPopularTags();
          observer.disconnect();
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
    addTagsToPopularTags();
  }
  function startDoubanTagRecommend() {
    window.addEventListener("load", () => {
      const keywords = extractKeywordsFromDoubanAdRequest();
      if (keywords.length === 0) {
        console.warn(" 未提取到任何关键词标签！");
        return;
      }
      mountInfoSection(keywords);
      mountPopularTags(keywords);
    });
  }

  // src/userscripts/douban-tag.user.js
  startDoubanTagRecommend();
})();
