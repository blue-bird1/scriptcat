/* global $, GM_getValue, GM_notification, GM_registerMenuCommand, GM_setValue, ZLibraryModal, ZLibraryNotify */

import {
  bookMatches,
  mergeOwnedBooks,
  parseOwnedLines,
  toOwnedText,
} from "./owned-booklist.js";

const LOG_PREFIX = "[zlib-local-owned-mark]";
const STORE_KEY = "ownedBooks";
const MODAL_ID = "ZLO-owned-modal";
const TEXT_ID = "ZLO-owned-text";
const FILE_ID = "ZLO-owned-file";
const SAVE_ID = "ZLO-owned-save";
const MODAL_CONTAINER = "zlibrary-modal-styled";
const MARK_CLASS = "zlocal-owned";
const SHADOW_MARK_STYLE = `
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
    offsetWidth: el.offsetWidth,
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
    if (bookMatches(identity, book)) {
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

function modalField(id) {
  return document.querySelector(`#${MODAL_CONTAINER} #${id}`) || document.getElementById(id);
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
  const container = document.createElement("div");
  container.className = "edit-book-container";
  const textGroup = document.createElement("div");
  textGroup.className = "form-group";
  const textLabel = document.createElement("label");
  textLabel.className = "control-label";
  textLabel.htmlFor = TEXT_ID;
  textLabel.textContent = "书单（每行：中文名 | 作者，或 中文名 | 外语名 | 作者）";
  const textarea = document.createElement("textarea");
  textarea.id = TEXT_ID;
  textarea.className = "form-control";
  textarea.rows = 12;
  textarea.placeholder = "足球潜规则 | 克雷格·麦盖尔\n加林查 | Garrincha | Ugo Riccarelli";
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
  chosen
    .text()
    .then((text) => {
      const parsed = parseOwnedLines(text);
      if (parsed.books.length === 0) {
        console.error(LOG_PREFIX, "file rejected", {
          name: chosen.name,
          skippedLines: parsed.skippedLines,
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
}

function saveOwnedList() {
  const textarea = modalField(TEXT_ID);
  const parsed = parseOwnedLines(textarea ? textarea.value : "");
  GM_setValue(STORE_KEY, parsed.books);
  const result = applyMarks(parsed.books);
  logSave(parsed, result);
  notifySuccess(
    `已保存 ${parsed.books.length} 本，标注 ${result.marked.length} 条` +
      (parsed.skippedLines.length ? `，跳过 ${parsed.skippedLines.length} 行` : ""),
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
    footer: `<div class="modal-footer"><button class="btn btn-success" id="${SAVE_ID}">保存并标注</button></div>`,
  });
  $(document)
    .off("click", `#${SAVE_ID}`)
    .on("click", `#${SAVE_ID}`, () => {
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

export function startZlibLocalOwnedMark() {
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
