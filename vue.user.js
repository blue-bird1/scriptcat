// ==UserScript==
// @name         scriptcat dev vue debug
// @namespace    https://docs.scriptcat.org/
// @version      0.1.2
// @description  Vue调试工具，支持通过菜单命令查找Vue元素和根节点
// @author       You
// @grant        GM_registerMenuCommand
// @match        *://*/*
// ==/UserScript==

(function () {
    'use strict';

    // 原有功能：从指定元素向上查找最近的Vue元素
    function findNearestVueElement(startEl) {
        if (!startEl || startEl.nodeType !== 1) {
            console.error('请传入有效的元素节点（nodeType必须为1）');
            return null;
        }

        let currentEl = startEl;
        while (currentEl) {
            if (currentEl.__vue__ && typeof currentEl.__vue__ === 'object') {
                console.log('找到最近的Vue元素：');
                console.log('标签:', currentEl.tagName.toLowerCase());
                console.log('元素引用:', currentEl); // 点击可定位
                return currentEl;
            }
            currentEl = currentEl.parentElement;
        }

        console.log('未找到最近的Vue元素（该元素及所有祖先均无__vue__属性）');
        return null;
    }

    // 原有功能：为Vue元素添加updated钩子
    function addUpdatedHook(el, callback) {
        const options = el.$options;
        if (!options.updated) {
            options.updated = [];
        } else if (!Array.isArray(options.updated)) {
            options.updated = [options.updated];
        }

        options.updated.push(function (...args) {
            callback.apply(this, args);
        });
    }

    // 新增功能：从外到内查找Vue根节点（最外层Vue实例挂载点）
    function findVueRoot() {
        // 从顶层元素开始遍历（html -> body -> 子元素）
        const rootCandidates = [document.documentElement, document.body];
        
        for (const candidate of rootCandidates) {
            if (!candidate) continue;
            const root = searchVueRootRecursive(candidate);
            if (root) {
                console.log('找到Vue根节点：');
                console.log('标签:', root.tagName.toLowerCase());
                console.log('元素引用:', root); // 点击可定位
                console.log('Vue实例:', root.__vue__); // 显示Vue实例
                return root;
            }
        }

        console.log('未找到Vue根节点（页面中可能没有Vue实例）');
        return null;
    }

    // 递归辅助函数：从外到内遍历查找根节点
    function searchVueRootRecursive(el) {
        // 检查当前元素是否是Vue实例且没有Vue父节点
        if (el.__vue__ && typeof el.__vue__ === 'object') {
            const parent = el.parentElement;
            // 根节点的父元素不应有__vue__属性
            if (!parent || !(parent.__vue__ && typeof parent.__vue__ === 'object')) {
                return el;
            }
        }

        // 递归检查子元素（从外到内顺序）
        const children = el.children;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child.nodeType !== 1) continue; // 只处理元素节点
            
            const found = searchVueRootRecursive(child);
            if (found) return found;
        }

        return null;
    }

    // 注册菜单命令：查找Vue根节点
    GM_registerMenuCommand('查找Vue根节点', () => {
        findVueRoot();
        console.log('可在控制台查看Vue根节点信息（点击元素引用可定位DOM）');
    }, 'r'); // 快捷键 Alt+R（可选）

    // 注册菜单命令：查找当前选中元素的最近Vue元素
    GM_registerMenuCommand('查找选中元素的最近Vue元素', () => {
        // 获取用户当前选中的元素（优先取激活元素，再取选中的第一个元素）
        const activeEl = document.activeElement;
        let targetEl;
        if (activeEl && activeEl.nodeType === 1) {
            targetEl = activeEl;
        } else {
            // 尝试获取选中的元素（如鼠标选中的DOM）
            const selection = window.getSelection();
            if (selection.rangeCount > 0) {
                const node = selection.getRangeAt(0).commonAncestorContainer;
                targetEl = node.nodeType === 1 ? node : node.parentElement;
            }
        }

        if (targetEl) {
            findNearestVueElement(targetEl);
            console.log('可在控制台查看最近的Vue元素信息（点击元素引用可定位DOM）');
        } else {
            console.warn('未找到选中的元素，请先点击页面中的一个元素再尝试');
        }
    }, 'n'); // 快捷键 Alt+N（可选）

    // 暴露全局方法方便控制台调用（保留）
    window.vueDebug = {
        findNearestVueElement,
        findVueRoot,
        addUpdatedHook
    };

    // 提示信息
    console.log('Vue调试工具已加载：');
    console.log('1. 可通过用户脚本菜单调用功能（快捷键 Alt+R 查找根节点，Alt+N 查找选中元素的Vue节点）');
    console.log('2. 控制台可直接调用：vueDebug.findVueRoot() / vueDebug.findNearestVueElement(元素)');
})();