export function readJsonObjectMeta(key, defaults, logLabel) {
  const raw = GM_getValue(key, "");
  if (!raw) {
    return { ...defaults };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("meta is not object");
    }
    return parsed;
  } catch (error) {
    if (logLabel) {
      console.warn(`${logLabel} 读取 JSON 元信息失败，已重置`, error);
    }
    return { ...defaults };
  }
}

export function writeJsonObjectMeta(key, value) {
  GM_setValue(key, JSON.stringify(value));
}
