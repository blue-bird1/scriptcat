import { catFileStorage, openCatFileStorageConfig } from "../userscript/cat-file-storage.js";
import { buildSessionFingerprint, createSiteCookieClient, serializeCookie } from "../userscript/gm-cookie.js";
import { readJsonObjectMeta, writeJsonObjectMeta } from "../userscript/gm-value-json.js";
import { formatError } from "../userscript/error.js";
import { notify } from "../userscript/notify.js";
import { tokenPreview } from "../userscript/preview.js";

const LOG_PREFIX = "[SteamPy Token Sync]";
const TOKEN_STORAGE_KEY = "accessToken";
const SITE_ORIGIN = "https://steampy.com";
const CLOUD_BASE_DIR = "steampy-token-sync";
const CLOUD_TOKEN_FILE = "access-token.json";
const SCHEMA_V1 = "steampy-token-sync/v1";
const SCHEMA_V2 = "steampy-token-sync/v2";
const AUTO_UPLOAD_KEY = "steampyTokenSync.autoUpload";
const AUTO_APPLY_KEY = "steampyTokenSync.autoApplyCloudToken";
const LOCAL_TOKEN_META_KEY = "steampyTokenSync.localTokenMeta";
const LAST_UPLOADED_SESSION_KEY = "steampyTokenSync.lastUploadedSession";
const LAST_APPLIED_CLOUD_AT_KEY = "steampyTokenSync.lastAppliedCloudAt";
const POLL_INTERVAL_MS = 5000;
const AUTO_UPLOAD_DEBOUNCE_MS = 1200;

const cookieClient = createSiteCookieClient(SITE_ORIGIN, LOG_PREFIX);

export function startSteampyTokenSync() {
  let autoUploadTimer = 0;
  let observedToken = "";

  function now() {
    return Date.now();
  }

  function readSiteToken() {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY) || "";
  }

  function writeSiteToken(token) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    saveLocalTokenMeta(token);
  }

  function isAutoUploadEnabled() {
    return GM_getValue(AUTO_UPLOAD_KEY, false);
  }

  function isAutoApplyEnabled() {
    return GM_getValue(AUTO_APPLY_KEY, false);
  }

  function getLocalTokenMeta() {
    const parsed = readJsonObjectMeta(
      LOCAL_TOKEN_META_KEY,
      { token: "", updatedAt: 0 },
      `${LOG_PREFIX} 本地 token`
    );
    return {
      token: typeof parsed.token === "string" ? parsed.token : "",
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  }

  function saveLocalTokenMeta(token) {
    writeJsonObjectMeta(LOCAL_TOKEN_META_KEY, {
      token,
      updatedAt: now(),
    });
  }

  function refreshLocalTokenMetaIfChanged() {
    const token = readSiteToken();
    const meta = getLocalTokenMeta();
    if (token && token !== meta.token) {
      saveLocalTokenMeta(token);
    }
    return token;
  }

  async function readCurrentSession(options = {}) {
    const includeCookies = options.includeCookies === true;
    const token = refreshLocalTokenMetaIfChanged();
    const cookies = includeCookies ? await cookieClient.listCookies() : [];
    return {
      token,
      cookies,
      fingerprint: includeCookies ? buildSessionFingerprint(token, cookies) : token,
    };
  }

  function normalizeCloudPayload(payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("云端 session 文件格式不正确");
    }
    if (payload.schema !== SCHEMA_V1 && payload.schema !== SCHEMA_V2) {
      throw new Error("云端 session 文件格式不正确");
    }
    if (typeof payload.token !== "string") {
      throw new Error("云端 session 文件缺少 token");
    }
    const cookies =
      payload.schema === SCHEMA_V2 && Array.isArray(payload.cookies)
        ? payload.cookies.map(serializeCookie)
        : [];
    return {
      schema: payload.schema,
      updatedAt: Number(payload.updatedAt) || 0,
      token: payload.token,
      tokenPreview: typeof payload.tokenPreview === "string" ? payload.tokenPreview : tokenPreview(payload.token),
      cookies,
      source: payload.source || null,
    };
  }

  async function uploadCloudSession(token, cookies, reason) {
    if (!token) {
      throw new Error("当前网站 localStorage.accessToken 为空，无法保存");
    }
    const payload = {
      schema: SCHEMA_V2,
      updatedAt: now(),
      token,
      tokenPreview: tokenPreview(token),
      cookies,
      source: {
        userAgent: navigator.userAgent,
        host: location.host,
        reason,
      },
    };
    await catFileStorage("upload", {
      baseDir: CLOUD_BASE_DIR,
      path: CLOUD_TOKEN_FILE,
      data: new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      }),
    });
    GM_setValue(LAST_UPLOADED_SESSION_KEY, buildSessionFingerprint(token, cookies));
    notify(
      "SteamPy 登录态已保存",
      `token + ${cookies.length} 个 cookie 已保存到 ScriptCat/app/${CLOUD_BASE_DIR}/${CLOUD_TOKEN_FILE}`,
      LOG_PREFIX
    );
    return payload;
  }

  async function listCloudTokenFile() {
    const files = await catFileStorage("list", {
      baseDir: CLOUD_BASE_DIR,
    });
    return files.find((file) => file.name === CLOUD_TOKEN_FILE);
  }

  async function downloadCloudSession() {
    const file = await listCloudTokenFile();
    if (!file) {
      throw new Error(`云端不存在 ${CLOUD_TOKEN_FILE}`);
    }
    const blob = await catFileStorage("download", {
      baseDir: CLOUD_BASE_DIR,
      file,
    });
    const text = await blob.text();
    return normalizeCloudPayload(JSON.parse(text));
  }

  function handleStorageError(title, error) {
    const message = formatError(error);
    console.error(`${LOG_PREFIX} ${title}`, error);
    notify(title, message, LOG_PREFIX);
    if (error && (error.code === 1 || error.code === 2)) {
      openCatFileStorageConfig();
    }
  }

  async function saveCurrentSessionManually() {
    try {
      const session = await readCurrentSession({ includeCookies: true });
      await uploadCloudSession(session.token, session.cookies, "manual-save");
    } catch (error) {
      handleStorageError("保存当前登录态失败", error);
    }
  }

  async function applyCloudSessionManually() {
    try {
      const payload = await downloadCloudSession();
      const currentToken = readSiteToken();
      const message = [
        "将用云端登录态覆盖当前浏览器的 SteamPy accessToken 与 Cookies。",
        "",
        `当前 token：${tokenPreview(currentToken)}`,
        `云端 token：${tokenPreview(payload.token)}`,
        `云端 cookies：${payload.cookies.length} 个`,
        `云端时间：${new Date(payload.updatedAt).toLocaleString()}`,
        "",
        "确认后 ScriptCat 可能请求 cookie 授权。覆盖后通常需要刷新页面。",
      ].join("\n");
      if (!window.confirm(message)) {
        return;
      }
      writeSiteToken(payload.token);
      const cookieResult = await cookieClient.applyCookies(payload.cookies);
      GM_setValue(LAST_APPLIED_CLOUD_AT_KEY, payload.updatedAt);
      const cookieText = payload.cookies.length
        ? `cookies ${cookieResult.applied}/${payload.cookies.length} 已写入`
        : "云端无 cookies，仅覆盖 token";
      notify("SteamPy 登录态已覆盖", `${cookieText}，请刷新 SteamPy 页面`, LOG_PREFIX);
    } catch (error) {
      handleStorageError("覆盖当前登录态失败", error);
    }
  }

  async function showStatus() {
    try {
      const session = await readCurrentSession({ includeCookies: true });
      const localMeta = getLocalTokenMeta();
      let cloudText = "未读取";
      try {
        const payload = await downloadCloudSession();
        cloudText = [
          `token ${tokenPreview(payload.token)}`,
          `cookies ${payload.cookies.length} 个`,
          new Date(payload.updatedAt).toLocaleString(),
        ].join(" / ");
      } catch (error) {
        cloudText = `读取失败：${formatError(error)}`;
      }
      window.alert(
        [
          "SteamPy Token Sync",
          "",
          `当前网站 token：${tokenPreview(session.token)}`,
          `当前网站 cookies：${session.cookies.length} 个`,
          `本地记录时间：${localMeta.updatedAt ? new Date(localMeta.updatedAt).toLocaleString() : "无"}`,
          `云端登录态：${cloudText}`,
          `自动保存：${isAutoUploadEnabled() ? "开启" : "关闭"}`,
          `自动覆盖：${isAutoApplyEnabled() ? "开启" : "关闭"}`,
          "",
          "未开启自动同步时，打开页面不会读取 cookies；手动保存/覆盖/查看状态时会请求 cookie 授权。",
        ].join("\n")
      );
    } catch (error) {
      handleStorageError("查看状态失败", error);
    }
  }

  function toggleAutoUpload() {
    const next = !isAutoUploadEnabled();
    GM_setValue(AUTO_UPLOAD_KEY, next);
    notify("SteamPy 登录态自动保存", next ? "已开启：变更时会读取 cookies 并上传" : "已关闭", LOG_PREFIX);
    if (next) {
      scheduleAutoUpload("enable-auto-upload");
    }
  }

  function toggleAutoApply() {
    const next = !isAutoApplyEnabled();
    GM_setValue(AUTO_APPLY_KEY, next);
    notify(
      "SteamPy 登录态自动覆盖",
      next ? "已开启：页面打开时云端较新会覆盖当前登录态" : "已关闭",
      LOG_PREFIX
    );
    if (next) {
      maybeApplyCloudSessionOnStartup();
    }
  }

  async function maybeApplyCloudSessionOnStartup() {
    if (!isAutoApplyEnabled()) {
      return;
    }
    try {
      const payload = await downloadCloudSession();
      const localToken = refreshLocalTokenMetaIfChanged();
      const localMeta = getLocalTokenMeta();
      const lastAppliedCloudAt = GM_getValue(LAST_APPLIED_CLOUD_AT_KEY, 0);
      const cloudIsNewer = payload.updatedAt > localMeta.updatedAt;
      const notYetApplied = payload.updatedAt > lastAppliedCloudAt;
      const sessionDiffers = payload.token !== localToken || payload.cookies.length > 0;
      if (!payload.token || !cloudIsNewer || !notYetApplied || !sessionDiffers) {
        return;
      }
      writeSiteToken(payload.token);
      const cookieResult = await cookieClient.applyCookies(payload.cookies);
      GM_setValue(LAST_APPLIED_CLOUD_AT_KEY, payload.updatedAt);
      const cookieText = payload.cookies.length
        ? `cookies ${cookieResult.applied}/${payload.cookies.length} 已写入`
        : "仅覆盖 token";
      notify("SteamPy 登录态已自动覆盖", `${cookieText}，请刷新页面`, LOG_PREFIX);
    } catch (error) {
      console.warn(`${LOG_PREFIX} 自动覆盖失败`, error);
    }
  }

  function scheduleAutoUpload(reason) {
    window.clearTimeout(autoUploadTimer);
    autoUploadTimer = window.setTimeout(async () => {
      if (!isAutoUploadEnabled()) {
        return;
      }
      try {
        const session = await readCurrentSession({ includeCookies: true });
        if (!session.token || session.fingerprint === GM_getValue(LAST_UPLOADED_SESSION_KEY, "")) {
          return;
        }
        await uploadCloudSession(session.token, session.cookies, reason);
      } catch (error) {
        console.warn(`${LOG_PREFIX} 自动保存失败`, error);
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
      }
      if (isAutoUploadEnabled()) {
        scheduleAutoUpload("token-change");
      }
    }, POLL_INTERVAL_MS);

    window.addEventListener("storage", (event) => {
      if (event.key !== TOKEN_STORAGE_KEY) {
        return;
      }
      observedToken = event.newValue || "";
      if (observedToken) {
        saveLocalTokenMeta(observedToken);
      }
      if (isAutoUploadEnabled()) {
        scheduleAutoUpload("storage-event");
      }
    });
  }

  function registerMenus() {
    GM_registerMenuCommand("保存当前 SteamPy 登录态到云端", saveCurrentSessionManually);
    GM_registerMenuCommand("用云端 SteamPy 登录态覆盖当前浏览器", applyCloudSessionManually);
    GM_registerMenuCommand("查看 SteamPy 登录态同步状态", showStatus);
    GM_registerMenuCommand(
      `${isAutoUploadEnabled() ? "关闭" : "开启"}：自动保存当前网站登录态`,
      toggleAutoUpload
    );
    GM_registerMenuCommand(
      `${isAutoApplyEnabled() ? "关闭" : "开启"}：自动用云端较新登录态覆盖当前浏览器`,
      toggleAutoApply
    );
  }

  observedToken = readSiteToken();
  refreshLocalTokenMetaIfChanged();
  registerMenus();
  startTokenObserver();
  if (isAutoApplyEnabled()) {
    maybeApplyCloudSessionOnStartup();
  }
}
