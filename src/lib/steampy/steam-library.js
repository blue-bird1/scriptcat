/* global ajax, GM_getValue, GM_setValue, GM_registerMenuCommand, GM_notification */

const STEAM_GAME_LIST_KEY = "steamGameList";
const FAMILY_LIBRARY_ENABLED_KEY = "steampyFamilyLibraryEnabled";
const STEAM_DYNAMIC_STORE_URL = "https://store.steampowered.com/dynamicstore/userdata/";
const STEAM_POINTS_CONFIG_URL = "https://store.steampowered.com/pointssummary/ajaxgetasyncconfig";
const STEAM_SHARED_LIBRARY_URL = "https://api.steampowered.com/IFamilyGroupsService/GetSharedLibraryApps/v1/";
const NOTIFICATION_TITLE = "SteamPy Plus";
const FAMILY_LIBRARY_MENU_ID = "steam-py-plus-family-library";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeAppId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} 包含无效 AppID`);
  }
  return value;
}

function normalizeAppIds(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 格式不正确`);
  }
  return [...new Set(value.map((appId) => normalizeAppId(appId, label)))];
}

function normalizeCachedAppIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((appId) => Number.isSafeInteger(appId) && appId > 0))];
}

function normalizeOpaqueList(value) {
  return Array.isArray(value) ? value.slice() : [];
}

function normalizePackageIds(value) {
  if (!Array.isArray(value)) {
    throw new Error("Steam 已拥有礼包格式不正确");
  }
  return value.slice();
}

function normalizeCachedState(value) {
  if (!isRecord(value)) {
    return { own: [], wish: [], sub: [], family: [] };
  }
  return {
    own: normalizeCachedAppIds(value.own),
    wish: normalizeCachedAppIds(value.wish),
    sub: normalizeOpaqueList(value.sub),
    family: normalizeCachedAppIds(value.family),
  };
}

function loadState() {
  const raw = GM_getValue(STEAM_GAME_LIST_KEY, "");
  if (!raw) {
    return { own: [], wish: [], sub: [], family: [] };
  }

  try {
    return normalizeCachedState(JSON.parse(raw));
  } catch (error) {
    console.warn("[SteamPy Plus] Steam 数据缓存格式不正确，已忽略", error);
    return { own: [], wish: [], sub: [], family: [] };
  }
}

function saveState(state) {
  GM_setValue(STEAM_GAME_LIST_KEY, JSON.stringify(state));
}

function readFamilyEnabled() {
  return GM_getValue(FAMILY_LIBRARY_ENABLED_KEY, false) === true;
}

function notify(text) {
  try {
    GM_notification({
      title: NOTIFICATION_TITLE,
      text,
      timeout: 3000,
    });
  } catch (error) {
    console.log(`${NOTIFICATION_TITLE}: ${text}`, error);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseDynamicStoreData(data) {
  if (!isRecord(data)) {
    throw new Error("Steam 自有库响应格式不正确");
  }
  return {
    own: normalizeAppIds(data.rgOwnedApps, "Steam 自有库"),
    wish: normalizeAppIds(data.rgWishlist, "Steam 愿望单"),
    sub: normalizePackageIds(data.rgOwnedPackages),
  };
}

function normalizeSteamId(value, label) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${label} 格式不正确`);
  }
  const steamId = String(value).trim();
  if (!/^\d+$/.test(steamId)) {
    throw new Error(`${label} 格式不正确`);
  }
  return steamId;
}

function parseFamilyLibraryData(data) {
  if (!isRecord(data) || !isRecord(data.response)) {
    throw new Error("Steam 家庭库响应格式不正确");
  }

  const { response } = data;
  if (!Array.isArray(response.apps)) {
    throw new Error("Steam 家庭库游戏列表格式不正确");
  }
  const ownerSteamId = normalizeSteamId(response.owner_steamid, "Steam 家庭库所有者");

  const familyAppIds = response.apps.map((app, index) => {
    if (!isRecord(app) || !Array.isArray(app.owner_steamids) || typeof app.exclude_reason !== "number") {
      throw new Error(`Steam 家庭库游戏 #${index + 1} 格式不正确`);
    }
    const appId = normalizeAppId(app.appid, "Steam 家庭库");
    const ownerSteamIds = app.owner_steamids.map((steamId) =>
      normalizeSteamId(steamId, `Steam 家庭库游戏 #${index + 1} 的所有者`)
    );

    return app.exclude_reason === 0 && !ownerSteamIds.includes(ownerSteamId) ? appId : null;
  });

  return [...new Set(familyAppIds.filter((appId) => appId !== null))];
}

async function requestDynamicStoreData() {
  const data = await ajax(STEAM_DYNAMIC_STORE_URL, {
    method: "GET",
    responseType: "json",
    _nocatch: true,
  });
  return parseDynamicStoreData(data);
}

async function requestFamilyLibraryData() {
  const config = await ajax(STEAM_POINTS_CONFIG_URL, {
    method: "GET",
    responseType: "json",
    _nocatch: true,
  });
  const token = config?.success && isRecord(config.data) ? config.data.webapi_token : null;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("无法取得 Steam 家庭库访问令牌");
  }

  const data = await ajax(STEAM_SHARED_LIBRARY_URL, {
    method: "GET",
    data: {
      access_token: token,
      family_groupid: 0,
      include_excluded: true,
      include_free: true,
      include_non_games: true,
      include_own: true,
    },
    responseType: "json",
    _nocatch: true,
  });
  return parseFamilyLibraryData(data);
}

/**
 * Manage Steam ownership and optional Steam Family Library data for SteamPy Plus.
 *
 * @param {{ onChange?: () => void }} options
 */
export function createSteamLibraryManager({ onChange } = {}) {
  let state = loadState();
  let menusRegistered = false;

  function isFamilyEnabled() {
    return readFamilyEnabled();
  }

  function emitChange() {
    if (typeof onChange === "function") {
      onChange();
    }
  }

  async function sync() {
    try {
      const dynamicStoreData = await requestDynamicStoreData();
      let family = state.family;

      if (isFamilyEnabled()) {
        const familyData = await requestFamilyLibraryData();
        family = familyData;
      }

      state = {
        ...dynamicStoreData,
        family,
      };
      saveState(state);
      notify("同步Steam数据成功");
      emitChange();
      return state;
    } catch (error) {
      console.error("[SteamPy Plus] 同步Steam数据失败", error);
      notify(`同步Steam数据失败：${errorMessage(error)}`);
      return null;
    }
  }

  async function toggleFamilyLibrary() {
    const enabled = !isFamilyEnabled();
    GM_setValue(FAMILY_LIBRARY_ENABLED_KEY, enabled);
    registerFamilyMenu();

    if (enabled) {
      notify("已开启：将家庭库游戏视为已拥有，正在同步Steam数据");
      const syncedState = await sync();
      if (!syncedState) {
        notify("家庭库功能仍已开启；同步失败，已保留旧数据");
      }
      return;
    }

    notify("已关闭：将家庭库游戏视为已拥有");
    emitChange();
  }

  function registerFamilyMenu() {
    GM_registerMenuCommand(
      `${isFamilyEnabled() ? "关闭" : "开启"}：将家庭库游戏视为已拥有`,
      toggleFamilyLibrary,
      { id: FAMILY_LIBRARY_MENU_ID }
    );
  }

  function registerMenus() {
    if (menusRegistered) {
      return;
    }
    menusRegistered = true;
    GM_registerMenuCommand("同步Steam数据", sync);
    registerFamilyMenu();
  }

  function isGameOwned(appId) {
    const parsedAppId = Number(appId);
    if (!Number.isSafeInteger(parsedAppId) || parsedAppId <= 0) {
      return false;
    }
    return (
      state.own.includes(parsedAppId) ||
      (isFamilyEnabled() && state.family.includes(parsedAppId))
    );
  }

  function getState() {
    return state;
  }

  return { registerMenus, sync, isGameOwned, isFamilyEnabled, getState };
}
