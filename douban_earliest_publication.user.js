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

/**
 * 从字符串中提取年份（YYYY 格式）
 */
function extractYear(text) {
    const match = text.match(/(\d{4})年/);
    return match ? parseInt(match[1]) : null;
}

/**
 * 查找页面右侧"其他版本"区块，提取所有版本的出版日期
 * 基于实际页面结构：heading "这本书的其他版本" → list → listitem → link "[出版社] （YYYY）"
 */
function findOtherVersions() {
    const versions = [];
    // 优先通过精确类名匹配豆瓣页面上的“其他版本”容器
    let container = document.querySelector('div.gray_ad.version_works');

    if (!container) {
        console.log('未找到其他版本容器（div.gray_ad.version_works）');
        return versions;
    }

    // 列表条目通常为 li.mb8.pl
    let items = Array.from(container.querySelectorAll('li.mb8.pl'));
    console.log(`初步在页面找到 ${items.length} 个版本条目`);

    // 优先读取标题处显示的“全部X”数字来判断全部版本数
    let worksLinkEl = null;
    let totalCount = null;
    const heading = container.querySelector('h2');
    if (heading) {
        worksLinkEl = heading.querySelector('a[href*="/works/"]') || heading.querySelector('a');
        if (worksLinkEl && worksLinkEl.textContent) {
            const m = worksLinkEl.textContent.match(/全部\s*(\d+)/);
            if (m) totalCount = parseInt(m[1], 10);
        }
    }

    // 退回到在容器内搜索 works 链接（兼容旧结构）
    if (!worksLinkEl) {
        worksLinkEl = container.querySelector('a[href*="/works/"]');
    }

    // 如果标题中没有给出总数，则退回到条目数量判断
    const needFetchWorks = (totalCount !== null) ? (totalCount > 4) : false;

    // 如果判断需要到 works 页面抓取全部版本
    if (needFetchWorks) {
        if (worksLinkEl && worksLinkEl.href) {
            try {
                console.log('需要获取全部版本（依据标题总数或条目数量判断），开始 fetch works 页面：', worksLinkEl.href);
                const resp = fetch(worksLinkEl.href, { credentials: 'include' });
                // 解析并合并版本信息（异步处理）
                return resp.then(r => {
                    if (!r.ok) {
                        console.warn('无法获取 works 页面', r.status);
                        // 退回到当前页面的少量版本
                        return parseItems(items);
                    }
                    return r.text().then(html => {
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(html, 'text/html');

                        // 精确解析 works 页面：每个版本条目使用 class="bkses clearfix"
                        const entryNodes = Array.from(doc.querySelectorAll('div.bkses.clearfix'));
                        const candidates = [];
                        const seen = new Set();

                        for (const node of entryNodes) {
                            try {
                                // 链接通常在 .bkdesc a.pl2
                                const a = node.querySelector('.bkdesc a.pl2') || node.querySelector('a[href*="/subject/"]');
                                const href = a ? a.href : null;
                                if (!href || seen.has(href)) continue;

                                // 在 .bkdesc 中查找标注为“出版年”的 span.pl，然后取其紧接的文本节点
                                const bkdesc = node.querySelector('.bkdesc');
                                let year = null;
                                if (bkdesc) {
                                    const spans = Array.from(bkdesc.querySelectorAll('span.pl'));
                                    for (const s of spans) {
                                        const label = (s.textContent || '').trim().replace(/\s+/g, '');
                                        if (label.indexOf('出版年') !== -1) {
                                            // 紧接的文本节点可能是 s.nextSibling
                                            let next = s.nextSibling;
                                            let txt = '';
                                            if (next) {
                                                if (next.nodeType === Node.TEXT_NODE) txt = next.nodeValue.trim();
                                                else txt = (next.textContent || '').trim();
                                            }
                                            // 如果紧接文本为空，尝试查找下一个 element sibling or following text
                                            if (!txt) {
                                                const el = s.nextElementSibling;
                                                if (el) txt = (el.textContent || '').trim();
                                            }
                                            const m = txt.match(/(\d{4})/);
                                            if (m) {
                                                year = parseInt(m[1], 10);
                                            }
                                            break;
                                        }
                                    }
                                }

                                const desc = bkdesc ? bkdesc.textContent.trim().replace(/\s+/g, ' ') : (a ? a.textContent.trim() : '');
                                seen.add(href);
                                candidates.push({ text: desc, link: href, year: year || null });
                            } catch (e) {
                                // 忽略单个解析错误
                            }
                        }

                        const merged = mergeVersionCandidates(items, candidates);
                        console.log(`从 works 页面解析并合并后，共有 ${merged.length} 个版本`);
                        return merged;
                    });
                }).catch(err => {
                    console.warn('fetch works 页面失败：', err);
                    return parseItems(items);
                });
            } catch (e) {
                console.warn('处理 works 页面时发生异常：', e);
            }
        } else {
            console.log('未找到 works 页面链接，使用当前页面列出的版本');
        }
    }

    // 如果没有超过 4 个，或者未能 fetch works 页面，则解析当前 items
    return parseItems(items);

    // ----------------- 内部辅助函数 -----------------
    function parseItems(nodeList) {
        const out = [];
        for (const li of nodeList) {
            try {
                const a = li.querySelector('a[href*="/subject/"]');
                const text = a ? (a.textContent || a.innerText || '').trim() : (li.textContent || '').trim();
                const yearMatch = text.match(/（(\d{4})）|（(\d{4})年/);
                const pm = text.match(/(\d{4})年|（(\d{4})）|(\d{4})/);
                const year = yearMatch ? parseInt(yearMatch[1] || yearMatch[2], 10) : (pm ? parseInt(pm[1] || pm[2] || pm[3], 10) : null);
                const link = a ? a.href : null;
                if (year) {
                    out.push({ text: text, year: year, link: link });
                    console.log(`提取版本: ${text} (${year})`);
                }
            } catch (e) {
                // 忽略单个条目错误
            }
        }
        return out;
    }

    function mergeVersionCandidates(currentItems, candidates) {
        const map = new Map();
        // 先放当前页面 items
        for (const li of currentItems) {
            try {
                const a = li.querySelector && li.querySelector('a[href*="/subject/"]');
                const text = a ? (a.textContent || a.innerText || '').trim() : (li.textContent || '').trim();
                const yearMatch = text.match(/（(\d{4})）|（(\d{4})年/);
                const pm = text.match(/(\d{4})年|（(\d{4})）|(\d{4})/);
                const year = yearMatch ? parseInt(yearMatch[1] || yearMatch[2], 10) : (pm ? parseInt(pm[1] || pm[2] || pm[3], 10) : null);
                const link = a ? a.href : null;
                if (link) map.set(link, { text, year, link });
                else if (text) map.set(text, { text, year, link });
            } catch (e) {}
        }
        // 再放 works 页面 candidates
        for (const c of candidates) {
            if (!c.link && !c.text) continue;
            const key = c.link || c.text;
            if (!map.has(key)) {
                map.set(key, { text: c.text, year: c.year || null, link: c.link || null });
            }
        }
        return Array.from(map.values()).filter(v => v && v.year);
    }
}

/**
 * 从版本列表中找出最早的年份
 */
function findEarliestYear(versions) {
    if (!versions || versions.length === 0) return null;
    return Math.min(...versions.map(v => v.year));
}

/**
 * 从版本列表中找出最晚的年份
 */
function findLatestYear(versions) {
    if (!versions || versions.length === 0) return null;
    return Math.max(...versions.map(v => v.year));
}

/**
 * 在出版信息处添加最早出版时间标注，并显示是否最新版（按出版年）
 */
function annotateEarliestPublicationYear(earliestYear, latestYear) {
    // earliestYear / latestYear 可能来自其他版本列表，可能为 null
    // 本函数会尝试从当前页面 info 中提取出版年，与它们比较并标注
    // 如果找不到 #info 或任何可用年份，返回 false
    if (earliestYear === undefined) earliestYear = null;
    if (latestYear === undefined) latestYear = null;

    const infoEl = document.getElementById('info');
    if (!infoEl) {
        console.log('未找到 #info 元素');
        return false;
    }

    const infoText = infoEl.innerText || infoEl.textContent || '';
    const lines = infoText.split('\n').map(l => l.trim()).filter(Boolean);

    // 优先寻找包含“出版年”或“出版時間/出版时间”的行；否则寻找包含 4 位年份的行
    let publicationLine = lines.find(l => /出版年|出版時間|出版时间/.test(l));
    if (!publicationLine) {
        publicationLine = lines.find(l => /\d{4}/.test(l));
    }
    if (!publicationLine) {
        console.log('未找到出版年信息');
        return false;
    }

    // 从行中提取 4 位年份
    const yearMatch = publicationLine.match(/(\d{4})/);
    const currentYear = yearMatch ? parseInt(yearMatch[1], 10) : null;

    // 若当前页面没有年份，且其他版本也无法提供年份，则无法标注
    if (!currentYear && !earliestYear && !latestYear) {
        console.log('既无法从其他版本也无法从本页提取年份');
        return false;
    }

    const finalEarliest = currentYear && earliestYear ? Math.min(currentYear, earliestYear) : (earliestYear || currentYear);
    const finalLatest = currentYear && latestYear ? Math.max(currentYear, latestYear) : (latestYear || currentYear);

    // 创建并插入注释节点（若已存在则更新）
    let annotationDiv = document.getElementById('earliest-publication-annotation');
    if (!annotationDiv) {
        annotationDiv = document.createElement('div');
        annotationDiv.id = 'earliest-publication-annotation';
        annotationDiv.style.marginTop = '8px';
        annotationDiv.style.padding = '8px';
        annotationDiv.style.background = '#fffacd';
        annotationDiv.style.border = '1px solid #f0e68c';
        annotationDiv.style.borderRadius = '4px';
        annotationDiv.style.fontSize = '12px';
        annotationDiv.style.color = '#333';
        annotationDiv.style.lineHeight = '1.6';
        infoEl.appendChild(annotationDiv);
    }

    // 构建显示内容：
    // 1) 仅在本页晚于最早版本或本页无年份时显示“最早出版时间”
    // 2) 始终尝试显示“是否最新版”
    const parts = [];

    if (finalEarliest && (!currentYear || currentYear > finalEarliest)) {
        parts.push(`<strong>💡 真正最早出版时间：</strong> ${finalEarliest}年`);
    }

    if (finalLatest) {
        if (currentYear) {
            const isLatest = currentYear >= finalLatest;
            if (isLatest) {
                parts.push('<strong>📌 是否最新版：</strong> 是');
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

    annotationDiv.innerHTML = parts.join('<br>');
    console.log('已更新出版信息标注', { currentYear, earliestYear, latestYear, finalEarliest, finalLatest });
    return true;
}

/**
 * 主函数
 */
async function main() {
    try {
        console.log('=== 豆瓣图书最早出版时间标注脚本启动 ===');
        
        // 检查是否在图书页面
        const subjectId = location.pathname.match(/\/subject\/(\d+)/);
        if (!subjectId) {
            console.log('不在图书页面');
            return;
        }
        
        console.log(`检测到图书 ID: ${subjectId[1]}`);
        
        // 1. 查找其他版本（可能返回 Promise）
        const maybePromise = findOtherVersions();
        const versions = (maybePromise && typeof maybePromise.then === 'function') ? await maybePromise : maybePromise;
        const count = Array.isArray(versions) ? versions.length : 0;
        console.log(`找到 ${count} 个版本`);
        
        if (!versions || versions.length === 0) {
            console.log('未找到其他版本信息');
            return;
        }
        
        // 2. 找出最早的年份
        const earliestYear = findEarliestYear(versions);
        console.log(`最早出版年: ${earliestYear}`);
        
        if (!earliestYear) {
            console.log('无法提取年份信息');
            return;
        }
        
        // 3. 找出最晚年份并标注在出版信息处
        const latestYear = findLatestYear(versions);
        console.log(`最晚出版年: ${latestYear}`);
        annotateEarliestPublicationYear(earliestYear, latestYear);
        
    } catch (e) {
        console.error('脚本执行出错:', e);
    }
}

// 页面加载完成后执行
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
} else {
    main();
}
