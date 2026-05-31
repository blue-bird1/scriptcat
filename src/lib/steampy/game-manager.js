const STEAM_GAME_LIST_KEY = "steamGameList";

const DEFAULT_STEAM_GAME_LIST = {
  own: [],
  wish: [],
  sub: [],
};

export const STEAMPY_BASE_URL = "https://steampy.com/";

export const STEAMPY_LIST_SALE_PATH = "xboot/steamKeySale/listSale";

export const GameManager = {
  saveState(state) {
    GM_setValue(STEAM_GAME_LIST_KEY, JSON.stringify(state));
  },
  loadState() {
    const saved = JSON.parse(GM_getValue(STEAM_GAME_LIST_KEY, null));
    if (!saved) {
      return { ...DEFAULT_STEAM_GAME_LIST };
    }
    return saved;
  },
};

export function readSteampyPageToken() {
  return window.localStorage.getItem("accessToken");
}

/**
 * @param {typeof ajax} ajax - scriptcat ajax helper from @require
 * @returns {(url: string, method: string, data?: unknown) => ReturnType<typeof ajax>}
 */
export function createSteampyApiRequest(ajax) {
  return function requestSteampyApi(url, method, data) {
    return ajax(url, {
      method,
      data,
      responseType: "json",
      headers: {
        Accesstoken: readSteampyPageToken(),
      },
      _nocatch: true,
    });
  };
}
