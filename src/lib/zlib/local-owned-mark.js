/* global $, GM_getValue, GM_notification, GM_registerMenuCommand, GM_setValue, ZLibraryModal, ZLibraryNotify */

const LOG_PREFIX = "[zlib-local-owned-mark]";
const STORE_KEY = "ownedBooks";
const MODAL_ID = "ZLO-owned-modal";
const TEXT_ID = "ZLO-owned-text";
const FILE_ID = "ZLO-owned-file";
const SAVE_ID = "ZLO-owned-save";
const MARK_CLASS = "zlocal-owned";
const SHADOW_MARK_STYLE = `
        .zlocal-owned-mark {
            position: absolute;
            top: 0;
            left: 0;
            z-index: 12;
            pointer-events: none;
            opacity: 0;
        }
        .zlocal-owned-mark.show {
            opacity: 1;
        }
        .zlocal-owned-mark .label {
            position: absolute;
            top: 0;
            left: 0;
            background: #15803d;
            color: #fff;
            font-size: 11px;
            line-height: 1.8;
            padding: 2px 6px 0 4px;
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
    timeout: 4000,
  });
}

function notifySuccess(text) {
  notifyPage("success", text);
}

function notifyError(text) {
  console.error(LOG_PREFIX, text);
  notifyPage("error", text);
}

export function normalizeText(value) {
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function titlesMatch(left, right) {
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

export function authorKeys(value) {
  const keys = new Set();
  addAuthorKeys(keys, value);
  for (const part of String(value).split(/[;；、/]| and /i)) {
    addAuthorKeys(keys, part);
  }
  return keys;
}

export function authorsMatch(left, right) {
  const a = authorKeys(left);
  const b = authorKeys(right);
  for (const key of a) {
    if (b.has(key)) {
      return true;
    }
  }
  return false;
}

export function parseOwnedLines(text) {
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

export function mergeOwnedBooks(existing, incoming) {
  const byKey = new Map();
  for (const book of [...existing, ...incoming]) {
    if (!book || !book.title || !book.author) {
      continue;
    }
    const key = `${normalizeText(book.title)}\0${normalizeText(book.author)}`;
    if (!byKey.has(key)) {
      byKey.set(key, book);
    }
  }
  return [...byKey.values()];
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
    cards.push(...(root ? root.querySelectorAll("z-cover") : masonry.querySelectorAll("z-cover")));
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
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "本地已有";
    mark.append(label);
    main.append(mark);
  }
  return mark;
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

function logSave(parsed, result) {
  console.info(LOG_PREFIX, "save", {
    books: parsed.books,
    skippedLines: parsed.skippedLines,
    marked: result.marked,
    unmatched: result.unmatched,
    noIdentity: result.noIdentity,
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
    chosen
      .text()
      .then((text) => {
        const parsed = parseOwnedLines(text);
        if (parsed.books.length === 0) {
          console.error(LOG_PREFIX, "file rejected", {
            name: chosen.name,
            skippedLines: parsed.skippedLines,
          });
          notifyError("文件格式无效：需要每行 `书名 | 作者`");
          file.value = "";
          return;
        }
        const merged = mergeOwnedBooks(readStore(), parsed.books);
        textarea.value = toOwnedText(merged);
        file.value = "";
        console.info(LOG_PREFIX, "file merged", {
          name: chosen.name,
          incoming: parsed.books,
          skippedLines: parsed.skippedLines,
          merged,
        });
        notifySuccess(
          `文件有效 ${parsed.books.length} 本，合并后 ${merged.length} 本` +
            (parsed.skippedLines.length ? `，跳过 ${parsed.skippedLines.length} 行` : ""),
        );
      })
      .catch((error) => {
        console.error(LOG_PREFIX, "read file failed", error);
        notifyError(`读取文件失败：${error.message}`);
        file.value = "";
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
    `已保存 ${parsed.books.length} 本，标注 ${result.marked.length} 条` +
      (parsed.skippedLines.length ? `，跳过 ${parsed.skippedLines.length} 行` : ""),
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
    footer: `<div class="modal-footer"><button class="btn btn-success" id="${SAVE_ID}">保存并标注</button></div>`,
  });
  $(document)
    .off("click", `#${SAVE_ID}`)
    .on("click", `#${SAVE_ID}`, () => {
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

export function startZlibLocalOwnedMark() {
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
