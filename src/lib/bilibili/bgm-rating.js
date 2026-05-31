export const BANGUMI_RATING_CACHE_KEY = "bangumiRatingCache";
export const BILIBILI_ANIME_CACHE_KEY = "bilibiliAnimeCache";
export const BANGUMI_API_BASE = "https://api.bgm.tv/v0/subjects/";
export const BANGUMI_USER_AGENT = "bluebird/userscript";
export const BANGUMI_FETCH_TIMEOUT_MS = 10000;

let biliBangumiLinkData = null;

export function getScoreColor(score) {
  const scoreNum = parseFloat(score);
  if (scoreNum >= 9.5) return "#00b42a";
  if (scoreNum >= 9.0) return "#36b37e";
  if (scoreNum >= 8.0) return "#165dff";
  if (scoreNum >= 7.0) return "#ff7d00";
  return "#ff3838";
}

export function getBangumiScoreColor(score) {
  const scoreNum = parseFloat(score);
  if (scoreNum >= 9.5) return "#9c27b0";
  if (scoreNum >= 9.0) return "#7b1fa2";
  if (scoreNum >= 8.0) return "#673ab7";
  if (scoreNum >= 7.0) return "#5c6bc0";
  return "#7986cb";
}

export function getSeasonIdFromCard(cardElement) {
  const linkElem = cardElement.querySelector("a.cover-wrapper");
  if (!linkElem) return null;

  const linkHref = linkElem.getAttribute("href");
  const seasonIdMatch = linkHref.match(/ss(\d+)/);
  return seasonIdMatch ? parseInt(seasonIdMatch[1], 10) : null;
}

export function formatNumber(num) {
  if (num >= 10000) {
    return (num / 10000).toFixed(1) + "万";
  }
  return num.toString();
}

export function extractMdId(link) {
  const href = link;
  if (!href) return null;
  const mdMatch = href.match(/\/media\/md(\d+)/) || href.match(/\/media\/ss(\d+)/);
  return mdMatch ? `${mdMatch[1]}` : null;
}

export function getBangumiIdFromMediaId(id, mappingJsonText) {
  const mdId = `md${id}`;
  if (!biliBangumiLinkData || Object.keys(biliBangumiLinkData).length === 0) {
    biliBangumiLinkData = JSON.parse(mappingJsonText);
  }
  const item = Object.values(biliBangumiLinkData).find(
    (entry) => entry.bili_id && entry.bili_id === mdId
  );
  return item ? item.bgm_id : null;
}

export function readBangumiRatingCache() {
  return GM_getValue(BANGUMI_RATING_CACHE_KEY, {});
}

export function writeBangumiRatingCache(cache) {
  GM_setValue(BANGUMI_RATING_CACHE_KEY, cache);
}

export function readBilibiliAnimeCache() {
  return GM_getValue(BILIBILI_ANIME_CACHE_KEY, {});
}

export function writeBilibiliAnimeCache(animeDataMap) {
  GM_setValue(BILIBILI_ANIME_CACHE_KEY, animeDataMap);
}

export function mergeSeasonListIntoAnimeCache(data, animeDataMap) {
  if (data.code === 0 && data.data?.list?.length > 0) {
    data.data.list.forEach((anime) => {
      if (anime.season_id && anime.score) {
        animeDataMap[anime.season_id] = anime;
      }
    });
    writeBilibiliAnimeCache(animeDataMap);
  }
  return animeDataMap;
}

/**
 * @param {string} bangumiId
 * @param {(rating: { score: string, userCount: string } | null) => void} callback
 * @param {{ requestCache?: Record<string, { score: string, userCount: string }> }} [options]
 */
export function fetchBangumiRating(bangumiId, callback, options = {}) {
  const requestCache = options.requestCache ?? readBangumiRatingCache();
  const cacheKey = `${BANGUMI_API_BASE}${bangumiId}`;
  if (requestCache[cacheKey]) {
    callback(requestCache[cacheKey]);
    return;
  }

  GM_xmlhttpRequest({
    method: "GET",
    url: `${BANGUMI_API_BASE}${bangumiId}`,
    responseType: "json",
    headers: {
      "User-Agent": BANGUMI_USER_AGENT,
      Accept: "application/json",
    },
    timeout: BANGUMI_FETCH_TIMEOUT_MS,
    onload: (response) => {
      if (response.status === 200 && response.response) {
        const { rating } = response.response;
        if (rating) {
          const result = {
            score: rating.score.toFixed(1),
            userCount: formatNumber(rating.total),
          };
          requestCache[cacheKey] = result;
          writeBangumiRatingCache(requestCache);
          callback(result);
        } else {
          console.error("Bangumi API无评分数据");
          callback(null);
        }
      } else {
        console.error("Bangumi API请求失败，状态码：", response.status);
        callback(null);
      }
    },
    onerror: (error) => {
      console.error("Bangumi API请求错误：", error);
      callback(null);
    },
    ontimeout: () => {
      console.error("Bangumi API请求超时");
      callback(null);
    },
  });
}

export function buildBangumiInlineScoreHtml(ratingData) {
  const scoreColor = getBangumiScoreColor(ratingData.score);
  return `
                    <span style="
                        margin-left: 2px;
                        padding: 1px 4px;
                        border-radius: 2px;
                        font-size: 14px;
                        font-weight: 500;
                        color: white;
                        background-color: ${scoreColor};
                        white-space: nowrap;
                        overflow: visible;
                        display: inline-block;
                    " class="bgm_score">
                        BGM ★${ratingData.score}
                    </span>
                `;
}

export function appendBiliScoreTag(card, animeData) {
  const seasonId = getSeasonIdFromCard(card);
  if (!seasonId) {
    return false;
  }
  if (!animeData || !animeData.score) {
    return false;
  }
  if (card.querySelector(".bili-score-tag")) {
    return false;
  }

  const coverWrapper = card.querySelector("a.cover-wrapper");
  if (!coverWrapper) {
    return false;
  }

  const scoreColor = getScoreColor(animeData.score);
  const scoreTag = document.createElement("span");
  scoreTag.className = "corner-tag bili-score-tag";
  scoreTag.style.cssText = `
        position: absolute;
        width: 60px;
        height: 24px;
        line-height: 24px;
        border-radius: 0 0 4px 0;
        top: 0;
        left: 0;
        font-size: 12px;
        text-align: center;
        background-color: ${scoreColor};
        color: #fff;
        z-index: 1;
    `;
  scoreTag.textContent = "★" + animeData.score;
  coverWrapper.appendChild(scoreTag);
  return true;
}

export function createBangumiRatingBlock(ratingData) {
  const bangumiRating = document.createElement("div");
  bangumiRating.className = "mediainfo_mediaRating__C5uvV";
  bangumiRating.style.cssText = `
        display: flex;
        flex-direction: column;
        align-items: center;
        margin-left: 16px;
        padding: 2px 0;
    `;

  const scoreElem = document.createElement("div");
  scoreElem.className = "mediainfo_score__SQ_KG";
  scoreElem.style.color = "#FB7299";
  scoreElem.innerHTML = `${ratingData.score}<span class="mediainfo_suffix__fXV4_">分</span>`;

  const countElem = document.createElement("div");
  countElem.className = "mediainfo_ratingText__N8GtM";
  countElem.style.color = "#9499A0";
  countElem.textContent = `${ratingData.userCount}人评分`;

  bangumiRating.appendChild(scoreElem);
  bangumiRating.appendChild(countElem);
  return bangumiRating;
}

export function createBangumiRatingError(msg) {
  const errorElem = document.createElement("div");
  errorElem.style.cssText = `
        margin-left: 16px;
        font-size: 12px;
        color: #9499A0;
        white-space: nowrap;
        `;
  errorElem.textContent = `Bangumi：${msg}`;
  return errorElem;
}
