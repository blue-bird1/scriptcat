import { STEAMPY_BASE_URL, STEAMPY_LIST_SALE_PATH, createSteampyApiRequest } from "./game-manager.js";

const CACHE_KEY = `${STEAMPY_LIST_SALE_PATH}_listSaleCache`;
const CACHE_DURATION_MS = 12 * 60 * 60 * 1000;

export function createSteamPySaleListClient({ ajax }) {
  const requestApi = createSteampyApiRequest(ajax);

  function getSaleList(gameId, { fresh = false } = {}) {
    const cache = GM_getValue(CACHE_KEY, {});
    const cached = cache[gameId];
    if (!fresh && cached?.expireTime > Date.now()) return Promise.resolve(cached.data);

    return requestApi(`${STEAMPY_BASE_URL}${STEAMPY_LIST_SALE_PATH}`, "GET", {
      gameId,
      pageNumber: 1,
      pageSize: 20,
      sort: "keyPrice",
      order: "asc",
      startDate: "",
      endDate: "",
    }).then((data) => {
      GM_setValue(CACHE_KEY, { ...cache, [gameId]: { data, expireTime: Date.now() + CACHE_DURATION_MS } });
      return data;
    });
  }

  return { getSaleList };
}
