const GM_ACCESS_TOKEN_KEY = "accessToken";
const LOCAL_ACCESS_TOKEN_KEY = "accessToken";

export function readSteampyLocalToken() {
  return window.localStorage.getItem(LOCAL_ACCESS_TOKEN_KEY) || "";
}

export function readSteampyGmToken(defaultValue = null) {
  return GM_getValue(GM_ACCESS_TOKEN_KEY, defaultValue);
}

export function syncSteampyTokenToGmStorage(options = {}) {
  const token = readSteampyLocalToken();
  if (!token) {
    return false;
  }
  GM_setValue(GM_ACCESS_TOKEN_KEY, token);
  if (options.log !== false) {
    const prefix = options.logPrefix || "[SteamPy]";
    console.log(`${prefix} 已同步 accessToken 到 GM 存储`);
  }
  return true;
}

export function syncSteampyTokenOnSteampyPage(options = {}) {
  if (!location.hostname.includes("steampy.com")) {
    return false;
  }
  return syncSteampyTokenToGmStorage(options);
}
