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

const NATIONALITY_RE = /^[（(][^）)]{1,12}[）)]/;

function addAuthorKeys(keys, raw) {
  const stripped = String(raw).replace(NATIONALITY_RE, "").replace(/[著编译]+$/g, "").trim();
  for (const piece of [raw, stripped]) {
    const value = normalizeText(piece);
    if (!value) {
      continue;
    }
    keys.add(value);
    const comma = value.split(",").map((part) => part.trim()).filter(Boolean);
    const lastFirstPairs =
      comma.length >= 2 &&
      comma.length % 2 === 0 &&
      comma.every((part, index) => index % 2 === 1 || !part.includes(" "));
    if (lastFirstPairs) {
      for (let index = 0; index < comma.length; index += 2) {
        keys.add(`${comma[index + 1]} ${comma[index]}`);
        keys.add(comma[index]);
        keys.add(comma[index + 1]);
      }
    } else {
      for (const part of comma) {
        keys.add(part);
      }
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

const FILE_EXT_RE = /\.(pdf|epub|mobi|txt|azw3|azw|djvu)$/i;
const YEAR_RE = /^\d{4}(-\d{2})?$/;
const ID_RE = /^\d{5,}$/;
const INDEX_RE = /^\d{1,3}$/;
const PUBLISHER_RE = /出版社|出版公司|书店|华文书局|CRC Press|Publishing/i;
const PLACE_YEAR_RE = /,\s*\d{4}$/;
const WIKI_RE = /维基百科|wikipedia/i;
const ROLE_RE = /著|编|译|主编/;
const TRAILING_YEAR_RE = /[-–—_]{1,2}\d{4}$/;
const ORG_RE = /^(FIFA|UEFA|DK)$/i;
const TITLE_HEAD_RE = /^(the|a|an|soccer|football|goalkeeping|training|systems|girls|advanced|essential|breakaway|inner|fit)$/i;

function cleanField(raw) {
  let value = String(raw).trim();
  value = value.replace(/^[-–—_\s]+/, "").replace(/[-–—_\s]+$/, "").trim();
  value = value.replace(TRAILING_YEAR_RE, "").trim();
  return value;
}

function dropNoiseFields(fields) {
  const next = [];
  for (const field of fields) {
    const value = cleanField(field);
    if (!value) {
      continue;
    }
    if (
      YEAR_RE.test(value) ||
      ID_RE.test(value) ||
      PUBLISHER_RE.test(value) ||
      PLACE_YEAR_RE.test(value) ||
      WIKI_RE.test(value) ||
      ORG_RE.test(value)
    ) {
      continue;
    }
    next.push(value);
  }
  return next;
}

function isAuthorLike(value) {
  if (!value || WIKI_RE.test(value) || PUBLISHER_RE.test(value) || ORG_RE.test(value)) {
    return false;
  }
  if (NATIONALITY_RE.test(value) || ROLE_RE.test(value)) {
    return true;
  }
  if (/,/.test(value) && /\p{L}/u.test(value)) {
    return true;
  }
  if (/^[\u4e00-\u9fff·．.\s]{2,16}(等)?$/.test(value) && !/手册|训练|课程|教材|百科/.test(value)) {
    return true;
  }
  const tokens = value.split(/\s+/);
  if (tokens.length >= 2 && tokens.length <= 4) {
    if (TITLE_HEAD_RE.test(tokens[0])) {
      return false;
    }
    if (value === value.toUpperCase() && /[A-Z]/.test(value)) {
      return false;
    }
    if (tokens.every((token) => /^[\p{L}.''’-]+$/u.test(token)) && value.length < 48) {
      return true;
    }
  }
  if (
    tokens.length === 1 &&
    /^[A-Za-zÀ-ÖØ-öø-ÿ.'’-]+$/.test(value) &&
    value.length >= 3 &&
    value.length <= 14
  ) {
    return true;
  }
  return false;
}

function pickTitle(fields) {
  if (fields.length && INDEX_RE.test(fields[0])) {
    return fields[1] || "";
  }
  return fields[0] || "";
}

function pickAuthor(fields) {
  const title = pickTitle(fields);
  const candidates = fields.filter((field) => field !== title);
  for (const field of candidates) {
    if (NATIONALITY_RE.test(field) || ROLE_RE.test(field) || /,/.test(field)) {
      return field;
    }
  }
  for (const field of [...candidates].reverse()) {
    if (isAuthorLike(field)) {
      return field;
    }
  }
  return "";
}

export function parseOwnedLine(line) {
  const trimmed = String(line).trim();
  if (!trimmed) {
    return { book: null, reason: "empty" };
  }
  const sep = trimmed.indexOf("|");
  if (sep > 0 && sep < trimmed.length - 1) {
    const title = trimmed.slice(0, sep).trim();
    const author = trimmed.slice(sep + 1).trim();
    if (title && author) {
      return { book: { title, author }, reason: null };
    }
    return { book: null, reason: "empty-field" };
  }
  const fields = dropNoiseFields(
    trimmed.replace(FILE_EXT_RE, "").split("---").flatMap((chunk) => chunk.split(/\s+--\s+/)),
  );
  const title = pickTitle(fields);
  const author = pickAuthor(fields);
  if (!title || !author) {
    return { book: null, reason: title ? "missing-author" : "missing-title" };
  }
  return { book: { title, author }, reason: null };
}

export function parseOwnedLines(text) {
  const books = [];
  const skippedLines = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, index) => {
    const parsed = parseOwnedLine(line);
    if (!parsed.book) {
      if (parsed.reason !== "empty") {
        skippedLines.push({ line: index + 1, reason: parsed.reason, text: line.trim() });
      }
      return;
    }
    books.push(parsed.book);
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
