// ==UserScript==
// @name               Z-Library local owned mark
// @name:zh-CN         Z-Library 本地已有标注
// @namespace          out
// @version            2026.9.9
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
// @grant              GM_getValue
// @grant              GM_setValue
// @grant              GM_registerMenuCommand
// @grant              GM_notification
// ==/UserScript==

/* global $, ZLibraryModal, ZLibraryNotify */

(() => {
  // src/lib/zlib/owned-booklist.js
  var FILE_EXT_RE = /\.(pdf|epub|mobi|txt|azw3|azw|djvu)$/i;
  var YEAR_RE = /^\d{4}(-\d{2})?$/;
  var ID_RE = /^\d{5,}$/;
  var INDEX_RE = /^\d{1,3}$/;
  function normalizeText(value) {
    return String(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  }
  function titlesMatch(left, right) {
    const a = normalizeText(left);
    const b = normalizeText(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    return shorter.length >= 4 && longer.includes(shorter);
  }
  function authorCandidates(value) {
    const fields = String(value).split(/[;；、/]|\s+--\s+|---|\band\b/i);
    return fields.flatMap((field) => field.split(",")).map((part) => normalizeText(part)).filter(Boolean);
  }
  function authorKeys(value) {
    const keys = /* @__PURE__ */ new Set();
    for (const candidate of authorCandidates(value)) {
      keys.add(candidate);
      keys.add(candidate.replace(/^[（(][^）)]{1,12}[）)]\s*/, ""));
    }
    return keys;
  }
  function authorsMatch(left, right) {
    const leftKeys = authorKeys(left);
    const rightKeys = authorKeys(right);
    return [...leftKeys].some((key) => key && rightKeys.has(key));
  }
  function scriptSet(value) {
    const scripts = /* @__PURE__ */ new Set();
    for (const char of String(value)) {
      if (/\p{Script=Han}/u.test(char)) scripts.add("han");
      else if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(char)) scripts.add("kana");
      else if (/\p{Script=Hangul}/u.test(char)) scripts.add("hangul");
      else if (/\p{Script=Cyrillic}/u.test(char)) scripts.add("cyrillic");
      else if (/\p{Script=Arabic}/u.test(char)) scripts.add("arabic");
      else if (/\p{Script=Latin}/u.test(char)) scripts.add("latin");
    }
    return scripts;
  }
  function isDifferentLanguage(left, right) {
    const a = scriptSet(left);
    const b = scriptSet(right);
    if (a.size === 0 || b.size === 0) return false;
    return ![...a].some((script) => b.has(script));
  }
  function cleanField(value) {
    return String(value).replace(/^[-–—_\s]+|[-–—_\s]+$/g, "").trim();
  }
  function filenameFields(line) {
    return String(line).replace(FILE_EXT_RE, "").split("---").map(cleanField).filter((field) => field && !YEAR_RE.test(field) && !ID_RE.test(field));
  }
  function filenameTitle(fields) {
    return INDEX_RE.test(fields[0] || "") ? fields[1] || "" : fields[0] || "";
  }
  function filenameAuthor(fields) {
    const titleIndex = INDEX_RE.test(fields[0] || "") ? 1 : 0;
    const title = fields[titleIndex] || "";
    const secondIndex = titleIndex + 1;
    const second = fields[secondIndex] || "";
    if (!second) return "";
    const inlineSeparator = second.indexOf(" -- ");
    if (inlineSeparator >= 0) {
      const inlineFields = second.split(/\s+--\s+/).map(cleanField).filter(Boolean);
      if (inlineFields[1]) return inlineFields[1];
    }
    if (isDifferentLanguage(title, second)) {
      return fields[secondIndex + 1] || "";
    }
    return second;
  }
  function parseOwnedLine(line) {
    const trimmed = String(line).trim();
    if (!trimmed) return { book: null, reason: "empty" };
    const separator = trimmed.indexOf("|");
    if (separator > 0 && separator < trimmed.length - 1) {
      const title2 = trimmed.slice(0, separator).trim();
      const author2 = trimmed.slice(separator + 1).trim();
      return title2 && author2 ? { book: { title: title2, author: author2 }, reason: null } : { book: null, reason: "empty-field" };
    }
    const fields = filenameFields(trimmed);
    const title = filenameTitle(fields);
    const author = filenameAuthor(fields);
    if (!title || !author) {
      return { book: null, reason: title ? "missing-author" : "missing-title" };
    }
    return { book: { title, author }, reason: null };
  }
  function parseOwnedLines(text) {
    const books = [];
    const skippedLines = [];
    for (const [index, line] of String(text).split(/\r?\n/).entries()) {
      const parsed = parseOwnedLine(line);
      if (parsed.book) books.push(parsed.book);
      else if (parsed.reason !== "empty") skippedLines.push({ line: index + 1, reason: parsed.reason, text: line.trim() });
    }
    return { books, skippedLines };
  }
  function mergeOwnedBooks(existing, incoming) {
    const byKey = /* @__PURE__ */ new Map();
    for (const book of [...existing, ...incoming]) {
      if (!book || !book.title || !book.author) continue;
      const key = `${normalizeText(book.title)}\0${normalizeText(book.author)}`;
      byKey.set(key, book);
    }
    return [...byKey.values()];
  }

  // src/lib/zlib/local-owned-mark.js
  var LOG_PREFIX = "[zlib-local-owned-mark]";
  var STORE_KEY = "ownedBooks";
  var MODAL_ID = "ZLO-owned-modal";
  var TEXT_ID = "ZLO-owned-text";
  var FILE_ID = "ZLO-owned-file";
  var SAVE_ID = "ZLO-owned-save";
  var MODAL_CONTAINER = "zlibrary-modal-styled";
  var MARK_CLASS = "zlocal-owned";
  var SHADOW_MARK_STYLE = `
        .zlocal-owned-mark {
            position: absolute;
            top: 0;
            left: 0;
            z-index: 12;
            pointer-events: none;
            opacity: 0;
            background: #15803d;
            color: #fff;
            line-height: 1.25;
            white-space: nowrap;
            border-radius: 0 0 10px 0;
            box-sizing: border-box;
        }
        .zlocal-owned-mark.show {
            opacity: 1;
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
      author: el.getAttribute("author"),
      offsetWidth: el.offsetWidth
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
  function paintableCovers(card) {
    if (card.tagName.toLowerCase() === "z-cover") {
      return [card];
    }
    if (card.shadowRoot) {
      return [...card.shadowRoot.querySelectorAll("z-cover")];
    }
    return [];
  }
  function ensureOwnedMark(cover) {
    const root = cover.shadowRoot;
    if (!root) {
      return null;
    }
    const main = root.querySelector(".main");
    if (!main) {
      return null;
    }
    if (!root.querySelector("style[data-zlocal-owned]")) {
      const style = document.createElement("style");
      style.setAttribute("data-zlocal-owned", "");
      style.textContent = SHADOW_MARK_STYLE;
      root.append(style);
    }
    let mark = main.querySelector(".zlocal-owned-mark");
    if (!mark) {
      mark = document.createElement("span");
      mark.className = "zlocal-owned-mark";
      mark.textContent = "本地已有";
      main.append(mark);
    } else {
      mark.textContent = "本地已有";
    }
    return mark;
  }
  function sizeOwnedMark(cover, mark) {
    const width = cover.offsetWidth;
    const fontSize = Math.max(7, Math.min(16, Math.round(width / 8)));
    mark.style.fontSize = `${fontSize}px`;
    mark.style.padding = width < 90 ? "1px 3px 0 2px" : "2px 6px 0 4px";
    return { width, fontSize };
  }
  function setOwnedVisible(card, owned) {
    const covers = paintableCovers(card);
    if (covers.length === 0) {
      return false;
    }
    let painted = false;
    for (const cover of covers) {
      const mark = ensureOwnedMark(cover);
      if (!mark) {
        continue;
      }
      if (owned) {
        sizeOwnedMark(cover, mark);
      }
      mark.classList.toggle("show", owned);
      painted = true;
    }
    return painted;
  }
  function applyMarks(books) {
    const marked = [];
    const unmatched = [];
    const noIdentity = [];
    for (const card of collectCards()) {
      const identity = cardIdentity(card);
      if (!identity) {
        card.classList.remove(MARK_CLASS);
        setOwnedVisible(card, false);
        noIdentity.push(describeCard(card));
        continue;
      }
      const matchedBook = matchOwned(identity, books);
      if (matchedBook) {
        card.classList.add(MARK_CLASS);
        const painted = setOwnedVisible(card, true);
        marked.push({ card: describeCard(card), identity, matchedBook, painted });
      } else {
        card.classList.remove(MARK_CLASS);
        setOwnedVisible(card, false);
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
  function modalField(id) {
    return document.querySelector(`#${MODAL_CONTAINER} #${id}`) || document.getElementById(id);
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
    const container = document.createElement("div");
    container.className = "edit-book-container";
    const textGroup = document.createElement("div");
    textGroup.className = "form-group";
    const textLabel = document.createElement("label");
    textLabel.className = "control-label";
    textLabel.htmlFor = TEXT_ID;
    textLabel.textContent = "书单";
    const textarea = document.createElement("textarea");
    textarea.id = TEXT_ID;
    textarea.className = "form-control";
    textarea.rows = 12;
    textarea.placeholder = "足球潜规则 | 克雷格·麦盖尔";
    textGroup.append(textLabel, textarea);
    const fileGroup = document.createElement("div");
    fileGroup.className = "form-group";
    const fileLabel = document.createElement("label");
    fileLabel.className = "control-label";
    fileLabel.textContent = "从文件导入";
    const fileBtn = document.createElement("label");
    fileBtn.className = "btn btn-default";
    fileBtn.htmlFor = FILE_ID;
    fileBtn.textContent = "选择文本文件";
    const file = document.createElement("input");
    file.id = FILE_ID;
    file.className = "hidden";
    file.type = "file";
    file.accept = "text/plain,.txt";
    fileGroup.append(fileLabel, fileBtn, file);
    container.append(textGroup, fileGroup);
    form.append(container);
    root.append(form);
    document.body.append(root);
  }
  function importOwnedFile(event) {
    const file = event.target;
    const chosen = file.files && file.files[0];
    if (!chosen) {
      console.info(LOG_PREFIX, "file change without file", { id: file.id });
      return;
    }
    const textarea = modalField(TEXT_ID);
    chosen.text().then((text) => {
      const parsed = parseOwnedLines(text);
      if (parsed.books.length === 0) {
        console.error(LOG_PREFIX, "file rejected", {
          name: chosen.name,
          skippedLines: parsed.skippedLines
        });
        notifyError("文件格式无效：没有可导入的书名和作者");
        file.value = "";
        return;
      }
      const merged = mergeOwnedBooks(readStore(), parsed.books);
      if (textarea) {
        textarea.value = toOwnedText(merged);
      }
      file.value = "";
      console.info(LOG_PREFIX, "file merged", {
        name: chosen.name,
        incoming: parsed.books,
        skippedLines: parsed.skippedLines,
        merged
      });
      notifySuccess(
        `文件有效 ${parsed.books.length} 本，合并后 ${merged.length} 本` + (parsed.skippedLines.length ? `，跳过 ${parsed.skippedLines.length} 行` : "")
      );
    }).catch((error) => {
      console.error(LOG_PREFIX, "read file failed", error);
      notifyError(`读取文件失败：${error.message}`);
      file.value = "";
    });
  }
  function saveOwnedList() {
    const textarea = modalField(TEXT_ID);
    const parsed = parseOwnedLines(textarea ? textarea.value : "");
    GM_setValue(STORE_KEY, parsed.books);
    const result = applyMarks(parsed.books);
    logSave(parsed, result);
    notifySuccess(
      `已保存 ${parsed.books.length} 本，标注 ${result.marked.length} 条` + (parsed.skippedLines.length ? `，跳过 ${parsed.skippedLines.length} 行` : "")
    );
  }
  function clearOwnedList() {
    const previous = readStore();
    GM_setValue(STORE_KEY, []);
    const textarea = modalField(TEXT_ID);
    if (textarea) {
      textarea.value = "";
    }
    const file = modalField(FILE_ID);
    if (file) {
      file.value = "";
    }
    const result = applyMarks([]);
    console.info(LOG_PREFIX, "clear", { previous, result });
    notifySuccess("已清空已保存的本地书单");
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
      container: MODAL_CONTAINER,
      title: "导入本地书单",
      footer: `<div class="modal-footer"><button class="btn btn-success" id="${SAVE_ID}">保存并标注</button></div>`
    });
    $(document).off("click", `#${SAVE_ID}`).on("click", `#${SAVE_ID}`, () => {
      saveOwnedList();
      modal.hide();
    });
    $(document).off("change", `#${FILE_ID}`).on("change", `#${FILE_ID}`, importOwnedFile);
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
    GM_registerMenuCommand("导入本地书单并标注", openModal);
    GM_registerMenuCommand("清空已保存书单", clearOwnedList);
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
