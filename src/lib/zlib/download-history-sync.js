/* global CurrentUser, GM_getValue, GM_notification, GM_registerMenuCommand, GM_setValue, ZLibraryNotify */

const LOG_PREFIX = "[zlib-download-history-sync]";
const STORE_KEY = "downloadedBooks";
const PAGE_KEY = "downloadedBooks";
const PAGE_USER_KEY = "downloadedBooksUser";
const PAGE_UPDATED_KEY = "downloadedBooksUpdated";

function zlibNotify() {
  if (typeof ZLibraryNotify !== "function") {
    return null;
  }
  return new ZLibraryNotify();
}

function notifyPage(kind, text) {
  const n = zlibNotify();
  if (n && typeof n[kind] === "function") {
    n[kind](text);
    return;
  }
  GM_notification({
    title: "Z-Library 下载历史",
    text,
    timeout: 4000,
  });
}

function notifySuccess(text) {
  console.info(LOG_PREFIX, text);
  notifyPage("success", text);
}

function notifyInfo(text) {
  console.info(LOG_PREFIX, text);
  notifyPage("info", text);
}

function notifyError(text) {
  console.error(LOG_PREFIX, text);
  notifyPage("error", text);
}

function bookId(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  if (item.id == null || item.id === "") {
    return null;
  }
  return item.id;
}

function hasIsbn(item) {
  return item && item.isbn != null && String(item.isbn).trim() !== "";
}

export function mergeDownloadedBooks(existing, incoming) {
  const byId = new Map();
  for (const item of [...existing, ...incoming]) {
    const id = bookId(item);
    if (id == null) {
      continue;
    }
    const key = String(id);
    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, item);
      continue;
    }
    if (!hasIsbn(prev) && hasIsbn(item)) {
      byId.set(key, { ...prev, ...item, id: prev.id });
    }
  }
  return [...byId.values()];
}

function readStore() {
  const stored = GM_getValue(STORE_KEY, []);
  if (!Array.isArray(stored)) {
    console.warn(LOG_PREFIX, "script store is not an array, reset to empty", stored);
    return [];
  }
  return stored;
}

function readPageBooks() {
  if (!window.localStorage) {
    throw new Error("当前页没有 localStorage");
  }
  const raw = localStorage.getItem(PAGE_KEY);
  if (raw == null || raw === "") {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(LOG_PREFIX, "invalid localStorage.downloadedBooks", raw, error);
    throw new Error("当前账号 downloadedBooks 不是合法 JSON");
  }
  if (!Array.isArray(parsed)) {
    console.warn(LOG_PREFIX, "localStorage.downloadedBooks is not an array", parsed);
    return [];
  }
  return parsed;
}

function collectCurrentAccount() {
  try {
    const current = readPageBooks();
    const stored = readStore();
    const merged = mergeDownloadedBooks(stored, current);
    GM_setValue(STORE_KEY, merged);
    console.info(LOG_PREFIX, "collected", {
      current: current.length,
      stored: stored.length,
      merged: merged.length,
    });
    notifySuccess(`已收集 ${current.length} 条，总历史 ${merged.length} 条`);
  } catch (error) {
    console.error(LOG_PREFIX, "collect failed", error);
    notifyError(`收集失败：${error.message}`);
  }
}

function overwriteCurrentAccount() {
  try {
    const stored = readStore();
    if (stored.length === 0) {
      notifyInfo("总历史为空，请先在各账号执行收集");
      return;
    }
    if (!window.localStorage) {
      throw new Error("当前页没有 localStorage");
    }
    if (typeof CurrentUser === "undefined" || CurrentUser.id == null) {
      throw new Error("当前页没有登录用户");
    }
    localStorage.setItem(PAGE_KEY, JSON.stringify(stored));
    localStorage.setItem(PAGE_USER_KEY, CurrentUser.id);
    localStorage.setItem(PAGE_UPDATED_KEY, String(new Date().getDate() + 1));
    if (typeof CurrentUser.markDownloadedBooks === "function") {
      CurrentUser.markDownloadedBooks();
    }
    console.info(LOG_PREFIX, "overwrote current account", {
      count: stored.length,
      userId: CurrentUser.id,
    });
    notifySuccess(`已用 ${stored.length} 条总历史覆盖当前账号`);
  } catch (error) {
    console.error(LOG_PREFIX, "overwrite failed", error);
    notifyError(`覆盖失败：${error.message}`);
  }
}

export function startZlibDownloadHistorySync() {
  GM_registerMenuCommand("收集当前已下载到总历史", collectCurrentAccount);
  GM_registerMenuCommand("用总历史覆盖当前已下载", overwriteCurrentAccount);
}
