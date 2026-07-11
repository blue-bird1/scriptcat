const RATING_CLASSES = [
  "overwhelmingly-positive",
  "very-positive",
  "positive",
  "mixed",
  "negative",
  "very-negative",
];

function normalizeAppId(appId) {
  const parsed = Number.parseInt(appId, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function getGameAppId(gameSource) {
  return normalizeAppId(typeof gameSource === "object" ? gameSource?.appId : gameSource);
}

function getSteamAppId(gameBlock, gameSource) {
  const fallbackAppId = getGameAppId(gameSource);
  if (fallbackAppId) return fallbackAppId;

  const iconImage = gameBlock.querySelector(".cdkGameIcon");
  const imageUrl = iconImage?.dataset.src || iconImage?.src;
  const match = imageUrl?.match(/steam\/apps\/(\d+)/);
  return match ? normalizeAppId(match[1]) : null;
}

function getRatingStyle(rating) {
  const percent = Math.round(rating * 100);
  if (percent >= 90) return ["好评如潮", "overwhelmingly-positive"];
  if (percent >= 80) return ["特别好评", "very-positive"];
  if (percent >= 70) return ["多半好评", "positive"];
  if (percent >= 40) return ["褒贬不一", "mixed"];
  if (percent >= 20) return ["多半差评", "negative"];
  return ["特别差评", "very-negative"];
}

export function createSteamPyRatingEnhancer({ libraryManager }) {
  let hotGameData = { result: { content: [] } };

  function setHotGameData(data) {
    hotGameData = data || { result: { content: [] } };
  }

  function findRating(appId, gameSource, extraGames = []) {
    const sourceRating = typeof gameSource === "object" ? Number(gameSource?.rating) : 0;
    if (sourceRating > 0) return sourceRating;

    const appIdNumber = Number(appId);
    const games = [...(hotGameData.result?.content || []), ...extraGames];
    return games.find((game) => Number(game.appId) === appIdNumber && Number(game.rating) > 0)?.rating || 0;
  }

  function updateCard(gameBlock, gameSource, extraGames) {
    if (!gameBlock) return;
    const appId = getSteamAppId(gameBlock, gameSource);
    if (!appId) return;

    if (libraryManager.getState().wish.includes(appId)) {
      gameBlock.querySelector(".gameName")?.classList.add("bg-blue");
    }

    const gameHead = gameBlock.querySelector(".gameHead");
    if (!gameHead) return;
    const ratingElement = gameHead.querySelector(".gameRating");
    const rating = findRating(appId, gameSource, extraGames);
    if (rating <= 0) {
      ratingElement?.remove();
      return;
    }

    const [text, className] = getRatingStyle(rating);
    if (ratingElement) {
      ratingElement.textContent = text;
      ratingElement.classList.remove(...RATING_CLASSES);
      ratingElement.classList.add(className);
      return;
    }

    const newRatingElement = document.createElement("div");
    newRatingElement.className = `gameRating ${className}`;
    newRatingElement.textContent = text;
    gameHead.appendChild(newRatingElement);
  }

  function processOpen(gameBlock, gameSource) {
    if (gameBlock.dataset.steamPyPlusOpenBound) return;
    gameBlock.dataset.steamPyPlusOpenBound = "true";
    gameBlock.addEventListener("mousedown", (event) => {
      if (event.button !== 1 || event.ctrlKey || event.shiftKey) return;
      const appId = getSteamAppId(gameBlock, gameSource);
      if (!appId) return;
      event.preventDefault();
      window.open(`https://store.steampowered.com/app/${appId}/`, "_blank");
    });
  }

  function processCards(gameBlocks, games, extraGames) {
    gameBlocks.forEach((gameBlock, index) => {
      const game = games?.[index];
      updateCard(gameBlock, game, extraGames);
      processOpen(gameBlock, game);
    });
  }

  function injectStyle() {
    document.getElementById("steamPyPlusRatingStyle")?.remove();
    const style = document.createElement("style");
    style.id = "steamPyPlusRatingStyle";
    style.textContent = `
      .gameHead .gameRating { padding: 0 8px !important; height: .3rem !important; position: absolute !important; top: 0 !important; left: 0 !important; color: #fff !important; text-align: center !important; line-height: .3rem !important; border-radius: .09rem 0 0 0 !important; font-size: .12rem !important; font-weight: bold !important; z-index: 10 !important; white-space: nowrap !important; }
      .gameRating.overwhelmingly-positive { background: #4CAF50 !important; }
      .gameRating.very-positive { background: #8BC34A !important; }
      .gameRating.positive { background: #CDDC39 !important; color: #333 !important; }
      .gameRating.mixed { background: #FFC107 !important; color: #333 !important; }
      .gameRating.negative { background: #FF9800 !important; }
      .gameRating.very-negative { background: #F44336 !important; }
    `;
    document.head.appendChild(style);
  }

  return { getSteamAppId, injectStyle, processCards, setHotGameData };
}
