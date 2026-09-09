const FILE_EXT_RE = /\.(pdf|epub|mobi|txt|azw3|azw|djvu)$/i;
const YEAR_RE = /^\d{4}(-\d{2})?$/;
const ID_RE = /^\d{5,}$/;
const INDEX_RE = /^\d{1,3}$/;

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

export function authorKeys(value) {
  const keys = new Set();
  for (const candidate of authorCandidates(value)) {
    keys.add(candidate);
    keys.add(candidate.replace(/^[（(][^）)]{1,12}[）)]\s*/, ""));
  }
  return keys;
}

export function authorsMatch(left, right) {
  const leftKeys = authorKeys(left);
  const rightKeys = authorKeys(right);
  return [...leftKeys].some((key) => key && rightKeys.has(key));
}

function scriptSet(value) {
  const scripts = new Set();
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
  return String(line)
    .replace(FILE_EXT_RE, "")
    .split("---")
    .map(cleanField)
    .filter((field) => field && !YEAR_RE.test(field) && !ID_RE.test(field));
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

  // Some generated names keep the author after an inline ` -- ` suffix.
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

export function parseOwnedLine(line) {
  const trimmed = String(line).trim();
  if (!trimmed) return { book: null, reason: "empty" };
  const separator = trimmed.indexOf("|");
  if (separator > 0 && separator < trimmed.length - 1) {
    const title = trimmed.slice(0, separator).trim();
    const author = trimmed.slice(separator + 1).trim();
    return title && author
      ? { book: { title, author }, reason: null }
      : { book: null, reason: "empty-field" };
  }
  const fields = filenameFields(trimmed);
  const title = filenameTitle(fields);
  const author = filenameAuthor(fields);
  if (!title || !author) {
    return { book: null, reason: title ? "missing-author" : "missing-title" };
  }
  return { book: { title, author }, reason: null };
}

export function parseOwnedLines(text) {
  const books = [];
  const skippedLines = [];
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    const parsed = parseOwnedLine(line);
    if (parsed.book) books.push(parsed.book);
    else if (parsed.reason !== "empty") skippedLines.push({ line: index + 1, reason: parsed.reason, text: line.trim() });
  }
  return { books, skippedLines };
}

export function mergeOwnedBooks(existing, incoming) {
  const byKey = new Map();
  for (const book of [...existing, ...incoming]) {
    if (!book || !book.title || !book.author) continue;
    const key = `${normalizeText(book.title)}\0${normalizeText(book.author)}`;
    byKey.set(key, book);
  }
  return [...byKey.values()];
}
