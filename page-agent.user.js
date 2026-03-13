// ==UserScript==
// @name         Page Agent (油猴版)
// @namespace    https://github.com/blue-bird1/scriptcat
// @version      1.3.0
// @description  自然语言操作网页，基于 alibaba/page-agent。默认关闭，Ctrl+Shift+P 打开。
// @author       blue-bird1
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      raw.githubusercontent.com
// @connect      page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run
// @connect      api.openai.com
// @connect      dashscope.aliyuncs.com
// @connect      api.deepseek.com
// @connect      api.anthropic.com
// @connect      generativelanguage.googleapis.com
// @connect      api.groq.com
// @connect      api.x.ai
// @connect      ark.cn-beijing.volces.com
// @require      https://raw.githubusercontent.com/blue-bird1/scriptcat/main/vendor/page-agent.js
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

/* global PageAgent */
(function () {
    'use strict';

    const CONFIG_KEY = 'pageAgent_config';
    const ENABLED_KEY = 'pageAgent_enabled';
    const DEMO_BASE = 'https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run';
    const DEMO_API_KEY = 'NA';

    function gmFetch(url, init = {}) {
        return new Promise((resolve, reject) => {
            let aborted = false;
            const signal = init.signal;
            if (signal?.aborted) {
                reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
                return;
            }
            const onAbort = () => {
                aborted = true;
                reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
            };
            if (signal) signal.addEventListener('abort', onAbort);

            const headers = {};
            if (init.headers) {
                if (init.headers instanceof Headers) {
                    init.headers.forEach((v, k) => { headers[k] = v; });
                } else {
                    Object.assign(headers, init.headers);
                }
            }

            GM_xmlhttpRequest({
                method: init.method || 'GET',
                url,
                headers,
                data: init.body,
                responseType: 'text',
                onload: (res) => {
                    if (aborted) return;
                    if (signal) signal.removeEventListener('abort', onAbort);
                    const h = new Headers();
                    (res.responseHeaders || '').split(/\r?\n/).forEach((line) => {
                        const i = line.indexOf(':');
                        if (i > 0) h.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
                    });
                    const body = res.responseText ?? '';
                    resolve({
                        ok: res.status >= 200 && res.status < 300,
                        status: res.status,
                        statusText: res.statusText || '',
                        headers: h,
                        json: () => Promise.resolve(JSON.parse(body)),
                        text: () => Promise.resolve(body),
                    });
                },
                onerror: () => {
                    if (aborted) return;
                    if (signal) signal.removeEventListener('abort', onAbort);
                    reject(new TypeError('Network request failed'));
                },
                onabort: () => {
                    if (signal) signal.removeEventListener('abort', onAbort);
                    reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
                },
            });
        });
    }

    function getConfig() {
        const raw = GM_getValue(CONFIG_KEY, null);
        if (!raw) {
            return {
                model: 'qwen3.5-plus',
                baseURL: DEMO_BASE,
                apiKey: DEMO_API_KEY,
                language: 'zh-CN',
            };
        }
        try {
            return JSON.parse(raw);
        } catch {
            return { model: 'qwen3.5-plus', baseURL: DEMO_BASE, apiKey: DEMO_API_KEY, language: 'zh-CN' };
        }
    }

    function saveConfig(cfg) {
        GM_setValue(CONFIG_KEY, JSON.stringify(cfg));
    }

    function getEnabled() {
        const v = GM_getValue(ENABLED_KEY, false);
        return v === true || v === 'true';
    }

    function setEnabled(v) {
        GM_setValue(ENABLED_KEY, !!v);
    }

    function escapeHtml(s) {
        if (s == null) return '';
        const div = document.createElement('div');
        div.textContent = String(s);
        return div.innerHTML;
    }

    let configDialogStylesInjected = false;

    function openConfig() {
        const c = getConfig();
        const existing = document.getElementById('sc-pa-config-dialog');
        if (existing) {
            existing.remove();
        }

        if (!configDialogStylesInjected) {
            configDialogStylesInjected = true;
            GM_addStyle(`
            .sc-pa-overlay { position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:2147483647; }
            .sc-pa-dialog { background:#fff;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.2);min-width:360px;max-width:90vw; }
            .sc-pa-dialog h3 { margin:0;padding:12px 16px;border-bottom:1px solid #eee;font-size:16px; }
            .sc-pa-form { padding:16px; }
            .sc-pa-field { margin-bottom:12px; }
            .sc-pa-field label { display:block;margin-bottom:4px;font-size:13px;color:#333; }
            .sc-pa-field input, .sc-pa-field select { width:100%;padding:8px 10px;border:1px solid #ccc;border-radius:4px;font-size:14px;box-sizing:border-box; }
            .sc-pa-field input:focus, .sc-pa-field select:focus { outline:none;border-color:#4a9; }
            .sc-pa-hint { font-size:12px;color:#666;margin-top:2px; }
            .sc-pa-actions { display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;border-top:1px solid #eee; }
            .sc-pa-btn { padding:8px 16px;border:none;border-radius:4px;cursor:pointer;font-size:14px; }
            .sc-pa-btn-primary { background:#4a9;color:#fff; }
            .sc-pa-btn-primary:hover { background:#3a8; }
            .sc-pa-btn-secondary { background:#eee;color:#333; }
            .sc-pa-btn-secondary:hover { background:#ddd; }
            @media (prefers-color-scheme: dark) {
                .sc-pa-dialog { background:#2a2a2a; }
                .sc-pa-dialog h3 { border-color:#444; }
                .sc-pa-field label { color:#ddd; }
                .sc-pa-field input, .sc-pa-field select { background:#333;border-color:#555;color:#eee; }
                .sc-pa-hint { color:#999; }
                .sc-pa-actions { border-color:#444; }
                .sc-pa-btn-secondary { background:#444;color:#ddd; }
                .sc-pa-btn-secondary:hover { background:#555; }
            }
        `);
        }

        const overlay = document.createElement('div');
        overlay.className = 'sc-pa-overlay';
        overlay.id = 'sc-pa-config-dialog';
        overlay.innerHTML = `
            <div class="sc-pa-dialog">
                <h3>配置 Page Agent</h3>
                <form class="sc-pa-form" id="sc-pa-form" autocomplete="off">
                    <div class="sc-pa-field">
                        <label for="sc-pa-baseURL">LLM API baseURL</label>
                        <input type="text" id="sc-pa-baseURL" value="${escapeHtml(c.baseURL)}" placeholder="${escapeHtml(DEMO_BASE)}" autocomplete="off">
                        <div class="sc-pa-hint">留空或填 Demo 地址使用公共演示</div>
                    </div>
                    <div class="sc-pa-field">
                        <label for="sc-pa-apiKey">API Key</label>
                        <input type="password" id="sc-pa-apiKey" value="${escapeHtml(c.apiKey)}" placeholder="Demo 填 NA" autocomplete="new-password">
                    </div>
                    <div class="sc-pa-field">
                        <label for="sc-pa-model">模型名</label>
                        <input type="text" id="sc-pa-model" value="${escapeHtml(c.model)}" placeholder="qwen3.5-plus">
                    </div>
                    <div class="sc-pa-field">
                        <label for="sc-pa-language">语言</label>
                        <select id="sc-pa-language">
                            <option value="zh-CN" ${c.language === 'zh-CN' ? 'selected' : ''}>zh-CN</option>
                            <option value="en-US" ${c.language === 'en-US' ? 'selected' : ''}>en-US</option>
                        </select>
                    </div>
                </form>
                <div class="sc-pa-actions">
                    <button type="button" class="sc-pa-btn sc-pa-btn-secondary" id="sc-pa-cancel">取消</button>
                    <button type="button" class="sc-pa-btn sc-pa-btn-primary" id="sc-pa-save">保存</button>
                </div>
            </div>
        `;

        function closeDialog() {
            overlay.remove();
        }

        overlay.querySelector('#sc-pa-save').addEventListener('click', () => {
            const saveBtn = overlay.querySelector('#sc-pa-save');
            saveBtn.disabled = true;
            saveBtn.textContent = '保存中...';
            try {
                const baseURL = overlay.querySelector('#sc-pa-baseURL').value.trim() || DEMO_BASE;
                const apiKey = overlay.querySelector('#sc-pa-apiKey').value.trim() || DEMO_API_KEY;
                const model = overlay.querySelector('#sc-pa-model').value.trim() || 'qwen3.5-plus';
                const lang = overlay.querySelector('#sc-pa-language').value;
                const next = { baseURL, apiKey, model, language: lang };
                saveConfig(next);
                if (typeof window.pageAgent !== 'undefined') {
                    window.pageAgent.dispose();
                }
                closeDialog();
                alert('配置已保存，Page Agent 已重新加载。');
                initAgent();
            } catch (err) {
                console.error('[Page Agent] 保存配置失败', err);
                alert('保存失败：' + (err?.message || String(err)));
                saveBtn.disabled = false;
                saveBtn.textContent = '保存';
            }
        });

        overlay.querySelector('#sc-pa-cancel').addEventListener('click', closeDialog);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeDialog();
        });

        document.body.appendChild(overlay);
    }

    function initAgent() {
        // 参考 scriptcat.org lib：顶层 var 创建全局，主脚本直接使用（非 window.X）
        // IIFE 输出为 exports 时构造函数在 PageAgent.PageAgent
        const PageAgentCls = (typeof PageAgent === 'function')
            ? PageAgent
            : (typeof PageAgent !== 'undefined' && PageAgent?.PageAgent);
        if (typeof PageAgentCls !== 'function') {
            console.error('[Page Agent] PageAgent 未加载，请检查 @require');
            alert('Page Agent 加载失败：PageAgent 未加载。请检查 @require 的 vendor 是否可达，详见控制台。');
            return;
        }
        const cfg = getConfig();
        const config = {
            ...cfg,
            customFetch: gmFetch,
        };
        window.pageAgent = new PageAgentCls(config);
        window.pageAgent.panel.show();
    }

    GM_registerMenuCommand('配置 Page Agent', openConfig);

    GM_registerMenuCommand('禁用 Page Agent', () => {
        if (typeof window.pageAgent !== 'undefined') {
            window.pageAgent.dispose();
            window.pageAgent = undefined;
        }
        setEnabled(false);
        alert('Page Agent 已禁用。按 Ctrl+Shift+P 可重新打开。');
    });

    GM_registerMenuCommand('启用 Page Agent', () => {
        setEnabled(true);
        initAgent();
    });

    function showOrInitAgent() {
        if (typeof window.pageAgent !== 'undefined') {
            window.pageAgent.panel.show();
        } else {
            initAgent();
        }
    }

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'P') {
            const target = e.target;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                return;
            }
            e.preventDefault();
            showOrInitAgent();
        }
    });

    if (getEnabled()) {
        initAgent();
    }
})();
