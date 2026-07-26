const STEAM_APP_URL = "https://store.steampowered.com/app/";
export const KEY_SALE_REQUEST_INTERVAL_MS = 10_500;

function waitFor(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorRecord(row, message, column = null, code = "invalid") {
  return {
    code,
    column,
    lineNumber: row?.lineNumber ?? null,
    rawLine: row?.rawLine ?? "",
    message,
  };
}

function parseCsvLine(line, lineNumber) {
  const fields = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (afterQuote) {
      if (character === ",") {
        fields.push(field.trim());
        field = "";
        afterQuote = false;
      } else if (/\s/.test(character)) {
        continue;
      } else {
        return { error: `第 ${lineNumber} 行：引号后只能出现逗号或行尾`, column: fields.length + 1 };
      }
      continue;
    }
    if (character === ",") {
      fields.push(field.trim());
      field = "";
    } else if (character === '"' && field.trim() === "") {
      field = "";
      quoted = true;
    } else {
      field += character;
    }
  }
  if (quoted) return { error: `第 ${lineNumber} 行：引号未闭合（不支持跨行字段）`, column: fields.length + 1 };
  fields.push(field.trim());
  return { fields };
}

export function parseBatchCsv(input) {
  const text = String(input ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  const errors = [];
  const seenKeys = new Map();
  const lines = text.split(/\r?\n/);

  lines.forEach((rawLine, lineIndex) => {
    const lineNumber = lineIndex + 1;
    if (rawLine.trim() === "") return;
    const parsed = parseCsvLine(rawLine, lineNumber);
    if (parsed.error) {
      errors.push({ code: "csv", column: parsed.column, lineNumber, rawLine, message: parsed.error });
      return;
    }
    const fields = parsed.fields;
    if (fields.length < 2 || fields.length > 4) {
      errors.push({ code: "field-count", column: null, lineNumber, rawLine, message: `第 ${lineNumber} 行：CSV 必须有 2 至 4 列` });
      return;
    }
    const [gameName = "", key = "", appId = "", gameId = ""] = fields;
    const row = { lineNumber, rawLine, gameName, key, appId, gameId };
    if (!key) errors.push(errorRecord(row, "key 不能为空", 2, "required-key"));
    if (!gameName && !appId && !gameId) errors.push(errorRecord(row, "至少提供 gameName、appId 或 gameId", null, "missing-locator"));
    if (appId && !/^[1-9][0-9]*$/.test(appId)) errors.push(errorRecord(row, "appId 必须是正整数文本", 3, "invalid-app-id"));
    if (gameId && !/^[1-9][0-9]*$/.test(gameId)) errors.push(errorRecord(row, "gameId 必须是正整数文本", 4, "invalid-game-id"));
    if (key) {
      const previous = seenKeys.get(key);
      if (previous) errors.push(errorRecord(row, `key 与第 ${previous} 行重复`, 2, "duplicate-key"));
      else seenKeys.set(key, lineNumber);
    }
    rows.push(row);
  });
  return { rows, errors };
}

function contentOf(response) {
  return response?.result?.content ?? response?.content ?? response?.result ?? response;
}

function uniqueGame(response) {
  const content = contentOf(response);
  const list = Array.isArray(content) ? content : [];
  if (list.length !== 1) return null;
  const item = list[0];
  const id = item?.id ?? item?.gameId;
  if (id === undefined || id === null) return null;
  return {
    appId: item?.appId === undefined || item?.appId === null ? "" : String(item.appId),
    gameId: String(id),
    gameName: String(item?.gameName ?? item?.name ?? ""),
  };
}

export async function preflightBatch(rows, {
  client,
  region = "cn",
  fetchKeySaleList = client?.fetchKeySaleList,
} = {}) {
  if (!client?.fetchSaleKeyByUrl || !client?.fetchSaleKeyByName || !fetchKeySaleList) {
    throw new TypeError("preflightBatch 需要 fetchSaleKeyByUrl、fetchSaleKeyByName 和 fetchKeySaleList");
  }
  const errors = [];
  const resolved = [];
  for (const row of rows) {
    try {
      let gameId = row.gameId || "";
      let matchedGame = null;
      if (row.appId) {
        matchedGame = uniqueGame(await client.fetchSaleKeyByUrl(`${STEAM_APP_URL}${row.appId}/`, region));
        if (!matchedGame) throw new Error("appId 未唯一解析到 SteamPy 商品");
        if (gameId && gameId !== matchedGame.gameId) {
          throw new Error(`appId 解析到 gameId=${matchedGame.gameId}，与显式 gameId=${gameId} 冲突`);
        }
        gameId ||= matchedGame.gameId;
      }
      if (!gameId) {
        matchedGame = uniqueGame(await client.fetchSaleKeyByName(row.gameName, region));
        if (!matchedGame) throw new Error("gameName 未唯一解析到 SteamPy 商品");
        gameId = matchedGame.gameId;
      }
      resolved.push({
        ...row,
        appId: row.appId || matchedGame?.appId || "",
        gameId,
        resolvedGameName: matchedGame?.gameName || row.gameName,
      });
    } catch (error) {
      errors.push(errorRecord(row, error?.message || String(error), null, "resolve"));
    }
  }

  const groups = new Map();
  for (const row of resolved) {
    if (!groups.has(row.gameId)) {
      groups.set(row.gameId, {
        appId: row.appId,
        gameId: row.gameId,
        gameName: row.resolvedGameName || row.gameName,
        rows: [],
        keys: [],
      });
    }
    const group = groups.get(row.gameId);
    group.rows.push(row);
    group.keys.push(row.key);
  }
  for (const group of groups.values()) {
    try {
      const response = await fetchKeySaleList({ gameId: group.gameId, region });
      const content = contentOf(response);
      const list = Array.isArray(content) ? content : [];
      if (!list.length) throw new Error("SteamPy 商品没有可用挂单价格");
      group.keyPrice = list[0]?.keyPrice;
      if (group.keyPrice === undefined || group.keyPrice === null || group.keyPrice === "") throw new Error("SteamPy 商品最低挂单缺少 keyPrice");
    } catch (error) {
      for (const row of group.rows) errors.push(errorRecord(row, error?.message || String(error), null, "price"));
    }
  }
  return { rows: resolved, groups: [...groups.values()].filter((group) => group.keyPrice !== undefined), errors };
}

export async function submitBatch(groups, {
  client,
  minimumIntervalMs = KEY_SALE_REQUEST_INTERVAL_MS,
  now = () => Date.now(),
  onSubmitting,
  onWaiting,
  region = "cn",
  shouldContinue = () => true,
  wait = waitFor,
} = {}) {
  if (!client?.startKeySale) throw new TypeError("submitBatch 需要 startKeySale");
  const results = [];
  let stopped = false;
  let pendingGroups = [];
  let lastRequestStartedAt = null;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!shouldContinue() || client.isTokenInvalid?.()) {
      stopped = true;
      pendingGroups = groups.slice(index);
      break;
    }
    if (lastRequestStartedAt !== null) {
      const waitMs = Math.max(0, lastRequestStartedAt + minimumIntervalMs - now());
      if (waitMs > 0) {
        onWaiting?.({ group, index, total: groups.length, waitMs });
        await wait(waitMs);
      }
      if (!shouldContinue() || client.isTokenInvalid?.()) {
        stopped = true;
        pendingGroups = groups.slice(index);
        break;
      }
    }
    onSubmitting?.({ group, index, total: groups.length });
    lastRequestStartedAt = now();
    try {
      const result = await client.startKeySale({
        region,
        gameId: group.gameId,
        keys: group.keys.join("\n"),
        sellPrice: group.keyPrice,
      });
      results.push({ ok: true, gameId: group.gameId, rows: group.rows, rawLines: group.rows.map((row) => row.rawLine), result });
    } catch (error) {
      results.push({ ok: false, gameId: group.gameId, rows: group.rows, rawLines: group.rows.map((row) => row.rawLine), error, message: error?.message || String(error) });
      if (client.isTokenInvalid?.()) {
        stopped = true;
        pendingGroups = groups.slice(index + 1);
        break;
      }
    }
  }
  return { results, stopped, pendingGroups };
}
