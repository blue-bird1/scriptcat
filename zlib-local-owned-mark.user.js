// ==UserScript==
// @name               Z-Library local owned mark
// @name:zh-CN         Z-Library 本地已有标注
// @namespace          out
// @version            2026.9.8.3
// @description        Mark Z-Library cards owned locally by title and author
// @description:zh-CN  按书名和作者标注本地已有的 Z-Library 书籍卡片
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
// @match              https://*.z-lib.gd/*
// @match              https://*.z-lib.gl/*
// @match              https://*.z-library.mn/*
// @run-at             document-end
// @grant              GM_addStyle
// @grant              GM_getValue
// @grant              GM_setValue
// @grant              GM_registerMenuCommand
// @grant              GM_notification
// ==/UserScript==

/* global $, ZLibraryModal, ZLibraryNotify */

(() => {
  // src/lib/zlib/local-owned-mark.js
  var LOG_PREFIX = "[zlib-local-owned-mark]";
  var STORE_KEY = "ownedBooks";
  var MODAL_ID = "ZLO-owned-modal";
  var TEXT_ID = "ZLO-owned-text";
  var FILE_ID = "ZLO-owned-file";
  var SAVE_ID = "ZLO-owned-save";
  var MARK_CLASS = "zlocal-owned";
  var MARK_STYLE = `
        z-cover.zlocal-owned,
        z-bookcard.zlocal-owned {
            position: relative;
        }
        z-cover.zlocal-owned::after,
        z-bookcard.zlocal-owned::after {
            content: "本地已有";
            position: absolute;
            top: 0;
            left: 0;
            z-index: 11;
            background: #15803d;
            color: #fff;
            font-size: 11px;
            line-height: 1.8;
            padding: 2px 6px 0 6px;
            border-radius: 0 0 10px 0;
        }
    `;
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
      title: "Z-Library 本地已有",
      text,
      timeout: 4e3
    });
  }
  function notifySuccess(text) {
    notifyPage("success", text);
  }
  function notifyError(text) {
    console.error(LOG_PREFIX, text);
    notifyPage("error", text);
  }
  function normalizeText(value) {
    return String(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  }
  function titlesMatch(left, right) {
    const a = normalizeText(left);
    const b = normalizeText(right);
    if (!a || !b) {
      return false;
    }
    if (a === b) {
      return true;
    }
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    if (shorter.length < 4) {
      return false;
    }
    return longer.includes(shorter);
  }
  function addAuthorKeys(keys, raw) {
    const value = normalizeText(raw);
    if (!value) {
      return;
    }
    keys.add(value);
    const comma = value.split(",");
    if (comma.length === 2) {
      const first = comma[0].trim();
      const second = comma[1].trim();
      if (first && second) {
        keys.add(`${second} ${first}`);
      }
    }
  }
  function authorKeys(value) {
    const keys = /* @__PURE__ */ new Set();
    addAuthorKeys(keys, value);
    for (const part of String(value).split(/[;；、/]| and /i)) {
      addAuthorKeys(keys, part);
    }
    return keys;
  }
  function authorsMatch(left, right) {
    const a = authorKeys(left);
    const b = authorKeys(right);
    for (const key of a) {
      if (b.has(key)) {
        return true;
      }
    }
    return false;
  }
  function parseOwnedLines(text) {
    const books = [];
    const skippedLines = [];
    const lines = String(text).split(/\r?\n/);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      const sep = trimmed.indexOf("|");
      if (sep <= 0 || sep === trimmed.length - 1) {
        skippedLines.push({ line: index + 1, reason: "missing-pipe", text: trimmed });
        return;
      }
      const title = trimmed.slice(0, sep).trim();
      const author = trimmed.slice(sep + 1).trim();
      if (!title || !author) {
        skippedLines.push({ line: index + 1, reason: "empty-field", text: trimmed });
        return;
      }
      books.push({ title, author });
    });
    return { books, skippedLines };
  }
  function slotText(el, name) {
    const slot = el.querySelector(`[slot="${name}"]`);
    return slot ? slot.textContent.trim() : "";
  }
  function cardIdentity(el) {
    if (!el || el.nodeType !== 1) {
      return null;
    }
    const tag = el.tagName.toLowerCase();
    if (tag !== "z-cover" && tag !== "z-bookcard") {
      return null;
    }
    if (el.hasAttribute("createbutton")) {
      return null;
    }
    const title = (el.getAttribute("title") || slotText(el, "title") || "").trim();
    const author = (el.getAttribute("author") || slotText(el, "author") || "").trim();
    if (!title || !author) {
      return null;
    }
    return { title, author };
  }
  function describeCard(el) {
    return {
      tag: el.tagName,
      id: el.getAttribute("id"),
      title: el.getAttribute("title"),
      author: el.getAttribute("author")
    };
  }
  function collectCards() {
    const cards = [];
    document.querySelectorAll("z-bookcard").forEach((card) => {
      if (!card.closest("z-masonry")) {
        cards.push(card);
      }
    });
    document.querySelectorAll("z-cover").forEach((cover) => {
      if (!cover.closest("z-masonry") && !cover.closest("z-bookcard")) {
        cards.push(cover);
      }
    });
    document.querySelectorAll("z-masonry").forEach((masonry) => {
      const root = masonry.shadowRoot;
      cards.push(...root ? root.querySelectorAll("z-cover") : masonry.querySelectorAll("z-cover"));
    });
    return cards;
  }
  function matchOwned(identity, books) {
    for (const book of books) {
      if (titlesMatch(identity.title, book.title) && authorsMatch(identity.author, book.author)) {
        return book;
      }
    }
    return null;
  }
  function applyMarks(books) {
    const marked = [];
    const unmatched = [];
    const noIdentity = [];
    for (const card of collectCards()) {
      const identity = cardIdentity(card);
      if (!identity) {
        card.classList.remove(MARK_CLASS);
        noIdentity.push(describeCard(card));
        continue;
      }
      const matchedBook = matchOwned(identity, books);
      if (matchedBook) {
        card.classList.add(MARK_CLASS);
        marked.push({ card: describeCard(card), identity, matchedBook });
      } else {
        card.classList.remove(MARK_CLASS);
        unmatched.push({ card: describeCard(card), identity });
      }
    }
    return { marked, unmatched, noIdentity };
  }
  function readStore() {
    const stored = GM_getValue(STORE_KEY, []);
    if (!Array.isArray(stored)) {
      return [];
    }
    return stored.filter((item) => item && item.title && item.author);
  }
  function toOwnedText(books) {
    return books.map((book) => `${book.title} | ${book.author}`).join("\n");
  }
  function logSave(parsed, result) {
    console.info(LOG_PREFIX, "save", {
      books: parsed.books,
      skippedLines: parsed.skippedLines,
      marked: result.marked,
      unmatched: result.unmatched,
      noIdentity: result.noIdentity
    });
  }
  function ensureModal() {
    if (document.getElementById(MODAL_ID)) {
      return;
    }
    const root = document.createElement("div");
    root.id = MODAL_ID;
    root.className = "hidden";
    const form = document.createElement("form");
    form.className = "form-horizontal";
    form.addEventListener("submit", (event) => event.preventDefault());
    const textarea = document.createElement("textarea");
    textarea.id = TEXT_ID;
    textarea.className = "form-control";
    textarea.rows = 12;
    textarea.placeholder = "足球潜规则 | 克雷格·麦盖尔";
    const file = document.createElement("input");
    file.id = FILE_ID;
    file.type = "file";
    file.accept = "text/plain,.txt";
    form.append(textarea, file);
    root.append(form);
    document.body.append(root);
    file.addEventListener("change", () => {
      const chosen = file.files && file.files[0];
      if (!chosen) {
        return;
      }
      chosen.text().then((text) => {
        textarea.value = text;
      }).catch((error) => {
        console.error(LOG_PREFIX, "read file failed", error);
        notifyError(`读取文件失败：${error.message}`);
      });
    });
  }
  function saveOwnedList() {
    const textarea = document.getElementById(TEXT_ID);
    const parsed = parseOwnedLines(textarea ? textarea.value : "");
    GM_setValue(STORE_KEY, parsed.books);
    const result = applyMarks(parsed.books);
    logSave(parsed, result);
    notifySuccess(
      `已保存 ${parsed.books.length} 本，标注 ${result.marked.length} 条` + (parsed.skippedLines.length ? `，跳过 ${parsed.skippedLines.length} 行` : "")
    );
  }
  function openModal() {
    if (typeof ZLibraryModal !== "function" || typeof $ === "undefined") {
      notifyError("当前页没有 ZLibraryModal");
      return;
    }
    ensureModal();
    const textarea = document.getElementById(TEXT_ID);
    if (textarea) {
      textarea.value = toOwnedText(readStore());
    }
    const modal = new ZLibraryModal({
      element: MODAL_ID,
      container: "zlibrary-modal-styled",
      title: "导入本地书单",
      footer: `<div class="modal-footer"><button class="btn btn-success" id="${SAVE_ID}">保存并标注</button></div>`
    });
    $(document).off("click", `#${SAVE_ID}`).on("click", `#${SAVE_ID}`, () => {
      saveOwnedList();
      modal.hide();
    });
    modal.show();
  }
  function observeMasonry(masonry, onChange) {
    if (!masonry.shadowRoot || masonry.dataset.zlocalObserved === "1") {
      return;
    }
    masonry.dataset.zlocalObserved = "1";
    const observer = new MutationObserver(onChange);
    observer.observe(masonry.shadowRoot, { childList: true, subtree: true });
  }
  function startZlibLocalOwnedMark() {
    GM_addStyle(MARK_STYLE);
    GM_registerMenuCommand("导入本地书单并标注", openModal);
    let scanTimer = 0;
    const scan = () => {
      document.querySelectorAll("z-masonry").forEach((masonry) => observeMasonry(masonry, scan));
      applyMarks(readStore());
    };
    const scheduleScan = () => {
      window.clearTimeout(scanTimer);
      scanTimer = window.setTimeout(scan, 200);
    };
    scan();
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // src/userscripts/zlib-local-owned-mark.user.js
  startZlibLocalOwnedMark();
})();
