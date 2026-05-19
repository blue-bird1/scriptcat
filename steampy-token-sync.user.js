// ==UserScript==
// @name         SteamPy Token Sync
// @name:zh-CN   SteamPy Token Sync
// @version      0.1.0
// @description  使用 ScriptCat 文件存储同步 SteamPy accessToken，支持手动保存和覆盖当前浏览器登录 token
// @author       bluebird
// @match        https://steampy.com/*
// @grant        CAT_fileStorage
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @run-at       document-idle
// @icon         https://steampy.com/m_logo.ico
// @license      MIT
// @namespace    https://greasyfork.org/users/
// ==/UserScript==

(function () {
    'use strict';

    const TOKEN_STORAGE_KEY = 'accessToken';
    const CLOUD_BASE_DIR = 'steampy-token-sync';
    const CLOUD_TOKEN_FILE = 'access-token.json';
    const AUTO_UPLOAD_KEY = 'steampyTokenSync.autoUpload';
    const AUTO_APPLY_KEY = 'steampyTokenSync.autoApplyCloudToken';
    const LOCAL_TOKEN_META_KEY = 'steampyTokenSync.localTokenMeta';
    const LAST_UPLOADED_TOKEN_KEY = 'steampyTokenSync.lastUploadedToken';
    const POLL_INTERVAL_MS = 5000;
    const AUTO_UPLOAD_DEBOUNCE_MS = 1200;

    let autoUploadTimer = 0;
    let observedToken = readSiteToken();

    function now() {
        return Date.now();
    }

    function notify(title, text) {
        try {
            GM_notification({
                title,
                text,
                timeout: 5000,
            });
        } catch (error) {
            console.log(`[SteamPy Token Sync] ${title}: ${text}`, error);
        }
    }

    function readSiteToken() {
        return window.localStorage.getItem(TOKEN_STORAGE_KEY) || '';
    }

    function writeSiteToken(token) {
        window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
        observedToken = token;
        saveLocalTokenMeta(token);
    }

    function tokenPreview(token) {
        if (!token) return '<empty>';
        if (token.length <= 12) return token;
        return `${token.slice(0, 6)}...${token.slice(-6)}`;
    }

    function getLocalTokenMeta() {
        const raw = GM_getValue(LOCAL_TOKEN_META_KEY, '');
        if (!raw) {
            return {
                token: '',
                updatedAt: 0,
            };
        }
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') {
                throw new Error('meta is not object');
            }
            return {
                token: typeof parsed.token === 'string' ? parsed.token : '',
                updatedAt: Number(parsed.updatedAt) || 0,
            };
        } catch (error) {
            console.warn('[SteamPy Token Sync] 读取本地 token 元信息失败，已重置', error);
            return {
                token: '',
                updatedAt: 0,
            };
        }
    }

    function saveLocalTokenMeta(token) {
        GM_setValue(LOCAL_TOKEN_META_KEY, JSON.stringify({
            token,
            updatedAt: now(),
        }));
    }

    function refreshLocalTokenMetaIfChanged() {
        const token = readSiteToken();
        const meta = getLocalTokenMeta();
        if (token && token !== meta.token) {
            saveLocalTokenMeta(token);
        }
        return token;
    }

    function fileStorage(action, details) {
        return new Promise((resolve, reject) => {
            CAT_fileStorage(action, {
                ...details,
                onload(data) {
                    resolve(data);
                },
                onerror(error) {
                    reject(error);
                },
            });
        });
    }

    async function uploadCloudToken(token, reason) {
        if (!token) {
            throw new Error('当前网站 localStorage.accessToken 为空，无法保存');
        }
        const payload = {
            schema: 'steampy-token-sync/v1',
            updatedAt: now(),
            token,
            tokenPreview: tokenPreview(token),
            source: {
                userAgent: navigator.userAgent,
                host: location.host,
                reason,
            },
        };
        await fileStorage('upload', {
            baseDir: CLOUD_BASE_DIR,
            path: CLOUD_TOKEN_FILE,
            data: new Blob([JSON.stringify(payload, null, 2)], {
                type: 'application/json',
            }),
        });
        GM_setValue(LAST_UPLOADED_TOKEN_KEY, token);
        notify('SteamPy token 已保存', `已保存到 ScriptCat/app/${CLOUD_BASE_DIR}/${CLOUD_TOKEN_FILE}`);
        return payload;
    }

    async function listCloudTokenFile() {
        const files = await fileStorage('list', {
            baseDir: CLOUD_BASE_DIR,
        });
        return files.find((file) => file.name === CLOUD_TOKEN_FILE);
    }

    async function downloadCloudToken() {
        const file = await listCloudTokenFile();
        if (!file) {
            throw new Error(`云端不存在 ${CLOUD_TOKEN_FILE}`);
        }
        const blob = await fileStorage('download', {
            baseDir: CLOUD_BASE_DIR,
            file,
        });
        const text = await blob.text();
        const payload = JSON.parse(text);
        if (!payload || payload.schema !== 'steampy-token-sync/v1' || typeof payload.token !== 'string') {
            throw new Error('云端 token 文件格式不正确');
        }
        return payload;
    }

    async function saveCurrentTokenManually() {
        try {
            const token = refreshLocalTokenMetaIfChanged();
            await uploadCloudToken(token, 'manual-save');
        } catch (error) {
            handleStorageError('保存当前 token 失败', error);
        }
    }

    async function applyCloudTokenManually() {
        try {
            const payload = await downloadCloudToken();
            const currentToken = readSiteToken();
            const message = [
                '将用云端 token 覆盖当前浏览器的 SteamPy localStorage.accessToken。',
                '',
                `当前：${tokenPreview(currentToken)}`,
                `云端：${tokenPreview(payload.token)}`,
                `云端时间：${new Date(payload.updatedAt).toLocaleString()}`,
                '',
                '覆盖后通常需要刷新页面。',
            ].join('\n');
            if (!window.confirm(message)) {
                return;
            }
            writeSiteToken(payload.token);
            notify('SteamPy token 已覆盖', '已用云端 token 覆盖当前浏览器 token，请刷新 SteamPy 页面');
        } catch (error) {
            handleStorageError('覆盖当前 token 失败', error);
        }
    }

    async function showStatus() {
        try {
            const localToken = refreshLocalTokenMetaIfChanged();
            const localMeta = getLocalTokenMeta();
            let cloudText = '未读取';
            try {
                const payload = await downloadCloudToken();
                cloudText = `${tokenPreview(payload.token)} / ${new Date(payload.updatedAt).toLocaleString()}`;
            } catch (error) {
                cloudText = `读取失败：${formatError(error)}`;
            }
            window.alert([
                'SteamPy Token Sync',
                '',
                `当前网站 token：${tokenPreview(localToken)}`,
                `本地记录时间：${localMeta.updatedAt ? new Date(localMeta.updatedAt).toLocaleString() : '无'}`,
                `云端 token：${cloudText}`,
                `自动保存：${GM_getValue(AUTO_UPLOAD_KEY, false) ? '开启' : '关闭'}`,
                `自动覆盖：${GM_getValue(AUTO_APPLY_KEY, false) ? '开启' : '关闭'}`,
            ].join('\n'));
        } catch (error) {
            handleStorageError('查看状态失败', error);
        }
    }

    function toggleAutoUpload() {
        const next = !GM_getValue(AUTO_UPLOAD_KEY, false);
        GM_setValue(AUTO_UPLOAD_KEY, next);
        notify('SteamPy token 自动保存', next ? '已开启' : '已关闭');
        if (next) {
            scheduleAutoUpload('enable-auto-upload');
        }
    }

    function toggleAutoApply() {
        const next = !GM_getValue(AUTO_APPLY_KEY, false);
        GM_setValue(AUTO_APPLY_KEY, next);
        notify('SteamPy token 自动覆盖', next ? '已开启：页面打开时云端较新会覆盖当前 token' : '已关闭');
        if (next) {
            maybeApplyCloudTokenOnStartup();
        }
    }

    async function maybeApplyCloudTokenOnStartup() {
        if (!GM_getValue(AUTO_APPLY_KEY, false)) {
            return;
        }
        try {
            const payload = await downloadCloudToken();
            const localToken = refreshLocalTokenMetaIfChanged();
            const localMeta = getLocalTokenMeta();
            if (payload.token && payload.token !== localToken && payload.updatedAt > localMeta.updatedAt) {
                writeSiteToken(payload.token);
                notify('SteamPy token 已自动覆盖', '云端 token 较新，已覆盖当前浏览器 token，请刷新页面');
            }
        } catch (error) {
            console.warn('[SteamPy Token Sync] 自动覆盖失败', error);
        }
    }

    function scheduleAutoUpload(reason) {
        window.clearTimeout(autoUploadTimer);
        autoUploadTimer = window.setTimeout(async () => {
            if (!GM_getValue(AUTO_UPLOAD_KEY, false)) {
                return;
            }
            const token = refreshLocalTokenMetaIfChanged();
            if (!token || token === GM_getValue(LAST_UPLOADED_TOKEN_KEY, '')) {
                return;
            }
            try {
                await uploadCloudToken(token, reason);
            } catch (error) {
                console.warn('[SteamPy Token Sync] 自动保存失败', error);
            }
        }, AUTO_UPLOAD_DEBOUNCE_MS);
    }

    function startTokenObserver() {
        window.setInterval(() => {
            const token = readSiteToken();
            if (token === observedToken) {
                return;
            }
            observedToken = token;
            if (token) {
                saveLocalTokenMeta(token);
                scheduleAutoUpload('token-change');
            }
        }, POLL_INTERVAL_MS);

        window.addEventListener('storage', (event) => {
            if (event.key !== TOKEN_STORAGE_KEY) {
                return;
            }
            observedToken = event.newValue || '';
            if (observedToken) {
                saveLocalTokenMeta(observedToken);
                scheduleAutoUpload('storage-event');
            }
        });
    }

    function formatError(error) {
        if (!error) return 'unknown error';
        if (typeof error === 'string') return error;
        if (error.error) return error.error;
        if (error.message) return error.message;
        try {
            return JSON.stringify(error);
        } catch {
            return String(error);
        }
    }

    function handleStorageError(title, error) {
        const message = formatError(error);
        console.error(`[SteamPy Token Sync] ${title}`, error);
        notify(title, message);
        if (error && (error.code === 1 || error.code === 2)) {
            CAT_fileStorage('config');
        }
    }

    function registerMenus() {
        GM_registerMenuCommand('保存当前 SteamPy token 到云端', saveCurrentTokenManually);
        GM_registerMenuCommand('用云端 SteamPy token 覆盖当前浏览器', applyCloudTokenManually);
        GM_registerMenuCommand('查看 SteamPy token 同步状态', showStatus);
        GM_registerMenuCommand(
            `${GM_getValue(AUTO_UPLOAD_KEY, false) ? '关闭' : '开启'}：自动保存当前网站 token`,
            toggleAutoUpload
        );
        GM_registerMenuCommand(
            `${GM_getValue(AUTO_APPLY_KEY, false) ? '关闭' : '开启'}：自动用云端较新 token 覆盖当前浏览器`,
            toggleAutoApply
        );
    }

    refreshLocalTokenMetaIfChanged();
    registerMenus();
    startTokenObserver();
    maybeApplyCloudTokenOnStartup();
})();
