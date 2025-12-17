// ==UserScript==
// @name         豆瓣图书最早出版时间标注
// @namespace    https://github.com/yourname/scriptcat
// @version      0.1.0
// @description  在豆瓣图书页面提取其他版本中最早的出版日期，并在出版年处标注真正的最早出版时间
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
    
    // 方案 1：通过标题文本找到区块，然后找相邻的列表
    const headings = document.querySelectorAll('h2, h3, strong, [role="heading"]');
    let versionList = null;
    
    for (const heading of headings) {
        if (heading.textContent.includes('其他版本')) {
            // 找到标题后，查找相邻的 list 或 ul 元素
            let nextEl = heading.parentElement;
            while (nextEl) {
                // 查找列表
                const list = nextEl.querySelector('ul, [role="list"], list');
                if (list) {
                    versionList = list;
                    break;
                }
                // 或者查找下一个兄弟元素中的列表
                const sibling = nextEl.nextElementSibling;
                if (sibling) {
                    const siblingList = sibling.querySelector('ul, [role="list"], list');
                    if (siblingList) {
                        versionList = siblingList;
                        break;
                    }
                    nextEl = sibling;
                } else {
                    break;
                }
            }
            if (versionList) break;
        }
    }
    
    // 方案 2：如果方案 1 失败，直接查找所有包含"其他版本"的通用容器
    if (!versionList) {
        const allGenerics = document.querySelectorAll('[role="region"], div');
        for (const generic of allGenerics) {
            const heading = generic.querySelector('h2, h3');
            if (heading && heading.textContent.includes('其他版本')) {
                // 查找该容器内的列表
                versionList = generic.querySelector('ul, [role="list"], list');
                if (versionList) break;
            }
        }
    }
    
    if (!versionList) {
        console.log('未找到其他版本列表');
        return versions;
    }
    
    console.log('找到版本列表，开始提取...');
    
    // 从列表中提取所有链接
    const links = versionList.querySelectorAll('a');
    for (const link of links) {
        const text = link.innerText || link.textContent;
        // 版本格式为："[出版社] （YYYY）"
        // 提取 （YYYY） 格式中的年份
        const yearMatch = text.match(/（(\d{4})）/);
        if (yearMatch) {
            const year = parseInt(yearMatch[1]);
            versions.push({
                text: text.trim(),
                year: year,
                link: link.href
            });
            console.log(`提取版本: ${text.trim()} (${year})`);
        }
    }
    
    return versions;
}

/**
 * 从版本列表中找出最早的年份
 */
function findEarliestYear(versions) {
    if (!versions || versions.length === 0) return null;
    return Math.min(...versions.map(v => v.year));
}

/**
 * 在出版信息处添加最早出版时间标注
 */
function annotateEarliestPublicationYear(earliestYear) {
    if (!earliestYear) return false;
    
    // 查找 #info 区块（豆瓣图书页的出版信息区块）
    const infoEl = document.getElementById('info');
    if (!infoEl) {
        console.log('未找到 #info 元素');
        return false;
    }
    
    // 查找包含"出版年"的文本
    const infoText = infoEl.innerText || infoEl.textContent;
    const lines = infoText.split('\n');
    
    let publicationLine = null;
    for (const line of lines) {
        if (line.includes('出版年') || line.includes('出版時間')) {
            publicationLine = line;
            break;
        }
    }
    
    if (!publicationLine) {
        console.log('未找到出版年信息');
        return false;
    }
    
    console.log('找到出版年信息:', publicationLine);
    
    // 在 #info 末尾或合适位置添加标注
    const annotationDiv = document.createElement('div');
    annotationDiv.id = 'earliest-publication-annotation';
    annotationDiv.style.marginTop = '8px';
    annotationDiv.style.padding = '8px';
    annotationDiv.style.background = '#fffacd';
    annotationDiv.style.border = '1px solid #f0e68c';
    annotationDiv.style.borderRadius = '4px';
    annotationDiv.style.fontSize = '12px';
    annotationDiv.style.color = '#333';
    annotationDiv.style.lineHeight = '1.6';
    
    annotationDiv.innerHTML = `<strong>💡 真正最早出版时间：</strong> ${earliestYear}年（根据其他版本推断）`;
    
    // 在 #info 块末尾插入
    infoEl.appendChild(annotationDiv);
    
    console.log(`已标注最早出版年: ${earliestYear}`);
    return true;
}

/**
 * 主函数
 */
function main() {
    try {
        console.log('=== 豆瓣图书最早出版时间标注脚本启动 ===');
        
        // 检查是否在图书页面
        const subjectId = location.pathname.match(/\/subject\/(\d+)/);
        if (!subjectId) {
            console.log('不在图书页面');
            return;
        }
        
        console.log(`检测到图书 ID: ${subjectId[1]}`);
        
        // 1. 查找其他版本
        const versions = findOtherVersions();
        console.log(`找到 ${versions.length} 个版本`);
        
        if (versions.length === 0) {
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
        
        // 3. 标注在出版信息处
        annotateEarliestPublicationYear(earliestYear);
        
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
