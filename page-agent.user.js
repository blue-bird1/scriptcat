// ==UserScript==
// @name         Page Agent (油猴版)
// @namespace    https://github.com/blue-bird1/scriptcat
// @version      1.0.0
// @description  自然语言操作网页，基于 alibaba/page-agent。自托管构建，无自动初始化。
// @author       scriptcat
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run
// @connect      api.openai.com
// @connect      dashscope.aliyuncs.com
// @connect      api.deepseek.com
// @connect      api.anthropic.com
// @connect      generativelanguage.googleapis.com
// @connect      api.groq.com
// @connect      api.x.ai
// @require      https://raw.githubusercontent.com/blue-bird1/scriptcat/main/vendor/page-agent.js
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG_KEY = 'pageAgent_config';
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

    function openConfig() {
        const c = getConfig();
        const baseURL = prompt('LLM API baseURL（留空用 Demo）', c.baseURL)?.trim() || DEMO_BASE;
        const apiKey = prompt('API Key（Demo 填 NA）', c.apiKey)?.trim() || DEMO_API_KEY;
        const model = prompt('模型名', c.model)?.trim() || 'qwen3.5-plus';
        const lang = prompt('语言：zh-CN / en-US', c.language)?.trim() || 'zh-CN';
        const next = { baseURL, apiKey, model, language: lang };
        saveConfig(next);
        if (typeof window.pageAgent !== 'undefined') {
            window.pageAgent.dispose();
        }
        initAgent();
        alert('配置已保存，Page Agent 已重新加载。');
    }

    function initAgent() {
        if (typeof window.PageAgent !== 'function') {
            console.error('[Page Agent] window.PageAgent 未加载，请检查 @require');
            return;
        }
        const cfg = getConfig();
        const config = {
            ...cfg,
            customFetch: gmFetch,
        };
        window.pageAgent = new window.PageAgent(config);
        window.pageAgent.panel.show();
    }

    GM_registerMenuCommand('配置 Page Agent', openConfig);

    initAgent();
})();
