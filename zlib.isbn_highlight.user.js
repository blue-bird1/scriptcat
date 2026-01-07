// ==UserScript==
// @name               Z-Library highlight missing ISBN Book
// @name:zh-CN         高亮Z-Library上 缺失 ISBN 的 bookcard
// @namespace          out
// @version            2025.12.28
// @description        高亮那些没有 isbn 属性或 isbn 为空的 z-bookcard 元素
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
// @run-at             document-end
// @grant              GM_addStyle
// ==/UserScript==

(function () {
    'use strict';

    // 样式：高亮缺失或为空 ISBN 的 z-bookcard
    GM_addStyle(`
        z-bookcard.isbn-missing-highlight {
            outline: 3px solid rgba(255,0,0,0.85);
            box-shadow: 0 0 10px rgba(255,0,0,0.35);
            position: relative;
        }
        z-bookcard.isbn-missing-highlight::after {
            content: "缺失 ISBN";
            color: #fff;
            background: rgba(255,0,0,0.85);
            font-size: 11px;
            padding: 2px 6px;
            border-radius: 3px;
            position: absolute;
            top: 6px;
            right: 6px;
            z-index: 9999;
        }
    `);

    function isIsbnMissing(el) {
        if (!el) return false;
        const v = el.getAttribute('isbn');
        return v === null || String(v).trim().length === 0;
    }

    function checkAndHighlight(node) {
        if (!node) return;
        if (node.nodeType === 1 && node.tagName.toLowerCase() === 'z-bookcard') {
            if (isIsbnMissing(node)) {
                node.classList.add('isbn-missing-highlight');
                node.setAttribute('data-isbn-missing', '1');
            } else {
                node.classList.remove('isbn-missing-highlight');
                node.removeAttribute('data-isbn-missing');
            }
        }
    }

    // 初始扫描
    function scanExisting() {
        document.querySelectorAll('z-bookcard').forEach(checkAndHighlight);
    }

    // 监听新增节点与 isbn 属性变更
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type === 'childList' && m.addedNodes.length) {
                m.addedNodes.forEach(node => checkAndHighlight(node));
            } else if (m.type === 'attributes' && m.attributeName === 'isbn') {
                checkAndHighlight(m.target);
            }
        }
    });

    observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['isbn'] });

    // 运行
    scanExisting();

})();
