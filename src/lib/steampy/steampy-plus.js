import { readSteampyLocalToken } from "./access-token.js";
import { installSteamPyAjaxHooks } from "./steampy-plus-ajax-hooks.js";
import { createSteamPyAdvancedFilterController } from "./steampy-plus-advanced-filter.js";
import { createSteamPyBuyerController } from "./steampy-plus-buyer.js";
import { createSteamPyPriceFilter } from "./steampy-plus-filter.js";
import { createSteamPyRatingEnhancer } from "./steampy-plus-rating.js";
import { createSteamPySaleListClient } from "./steampy-plus-sale-cache.js";
import { createSteamPySellerController } from "./steampy-plus-seller.js";
import { createSteamLibraryManager } from "./steam-library.js";
import { createSteampyXbootClient } from "./xboot-client.js";

const LEGACY_BUYER_PATH = "/cdKey/cdKey";
const PRO_BUYER_PATH = "/pro/cdKey/cdKey";
const SELLER_PATH = "/pyUserInfo/sellerCDKey";
const DETAIL_PATH = "/cdkDetail";

export function startSteamPyPlus({ ajax, ajaxHooker, elmGetter, jQuery }) {
  let buyer;
  const libraryManager = createSteamLibraryManager({
    onChange() {
      buyer?.applyCurrent(location.pathname);
    },
  });
  const rating = createSteamPyRatingEnhancer({ libraryManager });
  const filter = createSteamPyPriceFilter({
    libraryManager,
    onApply() {
      buyer.applyCurrent(location.pathname);
    },
  });
  const xbootClient = createSteampyXbootClient({ getAccessToken: readSteampyLocalToken });
  const advancedFilter = createSteamPyAdvancedFilterController({
    fetchFilterMetadata: xbootClient.fetchFilterMetadata,
    fetchSteamAppList: xbootClient.fetchSteamAppList,
    fetchSteamGameByAppId: xbootClient.fetchSteamGameByAppId,
    setHideDlcSuspended: filter.setHideDlcSuspended,
  });
  buyer = createSteamPyBuyerController({ advancedFilter, elmGetter, jQuery, filter, rating });
  const saleListClient = createSteamPySaleListClient({ ajax });
  const seller = createSteamPySellerController({ elmGetter, jQuery, getSaleList: saleListClient.getSaleList });

  installSteamPyAjaxHooks({ ajaxHooker, jQuery, onHotGames: rating.setHotGameData });
  libraryManager.registerMenus();
  elmGetter.selector(jQuery);

  let legacyActive = false;
  let proActive = false;
  let sellerActive = false;

  function startBuyer(pathname) {
    if (pathname.startsWith(LEGACY_BUYER_PATH) && !legacyActive) {
      rating.injectStyle();
      buyer.startLegacy().then(() => {
        filter.mount();
        buyer.applyCurrent(pathname);
      });
      legacyActive = true;
    } else if (!pathname.startsWith(LEGACY_BUYER_PATH) && legacyActive) {
      buyer.cleanupLegacy();
      legacyActive = false;
    }

    if (pathname.startsWith(PRO_BUYER_PATH) && !proActive) {
      rating.injectStyle();
      buyer.startPro().then(() => {
        filter.mount();
        buyer.applyCurrent(pathname);
      });
      proActive = true;
    } else if (!pathname.startsWith(PRO_BUYER_PATH) && proActive) {
      buyer.cleanupPro();
      proActive = false;
    }
  }

  function handlePathChange() {
    const pathname = location.pathname;
    startBuyer(pathname);
    if (pathname.startsWith(SELLER_PATH) && !sellerActive) {
      seller.start();
      sellerActive = true;
    } else if (!pathname.startsWith(SELLER_PATH) && sellerActive) {
      seller.cleanup();
      sellerActive = false;
    }
    if (pathname.startsWith(DETAIL_PATH)) console.log("[SteamPy Plus] 进入 CDKey 详情页");
  }

  let lastPath = location.pathname + location.search;
  const { pushState, replaceState } = history;
  history.pushState = function steamPyPlusPushState(...args) {
    pushState.apply(this, args);
    const nextPath = location.pathname + location.search;
    if (nextPath !== lastPath) {
      lastPath = nextPath;
      handlePathChange();
    }
  };
  history.replaceState = function steamPyPlusReplaceState(...args) {
    replaceState.apply(this, args);
    const nextPath = location.pathname + location.search;
    if (nextPath !== lastPath) {
      lastPath = nextPath;
      handlePathChange();
    }
  };
  window.addEventListener("popstate", handlePathChange);
  window.addEventListener("hashchange", handlePathChange);
  handlePathChange();
}
