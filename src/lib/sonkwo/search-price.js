import { syncSteampyTokenOnSteampyPage } from "../steampy/access-token.js";
import { createSteampyXbootClient } from "../steampy/xboot-client.js";

/* global ajaxHooker, GM_setValue, GM_getValue, GM_registerMenuCommand */

export function startSnokwoSearchPrice() {
  if (location.hostname.includes("steampy.com")) {
    syncSteampyTokenOnSteampyPage({ logPrefix: "[SteamPY价格脚本]" });
    return;
  }

  ajaxHooker.hook((request) => {
    if (request.url.startsWith("https://www.sonkwo.cn/api/search/skus.json")) {
      request.response = (res) => {
        try {
          const data = JSON.parse(res.responseText);
          processGameData(data);
        } catch (e) {
          console.error("解析steampy API(XHR)数据失败：", e);
        }
      };
    }
    return request;
  });

  const gameData = {};

  function processGameData(data) {
    const skus = data.skus;
    for (const sku of skus) {
      const appid = sku.id;
      if (appid) {
        gameData[appid] = sku;
      }
    }
  }

  const steampyClient = createSteampyXbootClient({
    getAccessToken: () => GM_getValue("accessToken", ""),
    onTokenInvalid: () => {
      alert("提示：accesstoken可能已过期，请在脚本 CONFIG 区更新有效token！");
    },
  });

  function showError(message) {
    console.error(message);
  }

  async function fetchGamePrice(gameName) {
    try {
      console.log(`request saleKeyByName for ${gameName}`);
      const { result } = await steampyClient.fetchSaleKeyByName(gameName);
      return result;
    } catch (error) {
      showError(error);
      showError(`网络请求错误：${error.message || "无法连接到SteamPy服务器"}`);
    }
  }

  const processedItems = new Set();

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === "childList") {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1 && node.classList.contains("sku-list-item")) {
            if (!processedItems.has(node)) {
              processSkuItem(node);
              processedItems.add(node);
            }
          }

          if (node.nodeType === 1) {
            const skuItems = node.getElementsByClassName("sku-list-item");
            Array.from(skuItems).forEach((item) => {
              if (!processedItems.has(item)) {
                processSkuItem(item);
                processedItems.add(item);
              }
            });
          }
        });
      }

      if (mutation.type === "characterData" && mutation.target.parentNode) {
        const skuItem = mutation.target.parentNode.closest(".sku-list-item");
        if (skuItem && processedItems.has(skuItem)) {
          console.debug("处理文本内容变化", skuItem);
          processSkuItem(skuItem);
        }
      }

      if (mutation.type === "attributes") {
        const skuItem = mutation.target.closest(".sku-list-item");
        if (skuItem && processedItems.has(skuItem)) {
          console.debug("处理属性变化", skuItem);
          processSkuItem(skuItem);
        }
      }
    });
  });

  window.addEventListener("load", () => {
    console.log("加载完成 加载观察者");
    observer.observe(document.querySelector("#background_inner > div > div > div.search-left"), {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  });

  const processedSkusDict = GM_getValue("processedSkus", {});

  async function getGameData(skuId, title) {
    if (processedSkusDict[skuId] !== undefined) {
      console.debug(`重复处理，跳过${skuId} ${title}`);
      return processedSkusDict[skuId];
    }

    console.debug(`处理SKUid：${skuId} SKU标题：${title}`);
    const data = await fetchGamePrice(title);
    if (data) {
      if (data.content && data.content.length > 0) {
        const matchedGameData = data.content.find((game) => game.gameName === title);
        processedSkusDict[skuId] = matchedGameData || data.content[0];
        GM_setValue("processedSkus", processedSkusDict);
        return matchedGameData || data.content[0] || null;
      }
      processedSkusDict[skuId] = null;
      GM_setValue("processedSkus", processedSkusDict);
    } else {
      console.log(`获取数据失败 skuid:${skuId}  title:${title}`);
      processedSkusDict[skuId] = null;
      GM_setValue("processedSkus", processedSkusDict);
    }
  }

  async function processSkuItem(item) {
    const linkElement = item.querySelector("a.listed-game-block");
    if (!linkElement) {
      return;
    }

    const skuUrl = linkElement.getAttribute("href");
    const skuId = skuUrl.split("/").pop();
    const skuIdInt = parseInt(skuId, 10);
    const curGameData = gameData[skuIdInt];
    const titleEn = curGameData?.sku_names.en;

    try {
      const data = await getGameData(skuId, titleEn);

      if (data && data.keyPrice !== undefined) {
        addPriceInfoToItem(item, data, curGameData);
      } else {
        console.log(`未找到${titleEn}的价格数据`);
      }
    } catch (error) {
      console.error(`处理${titleEn}时出错:`, error);
    }
  }

  function addPriceInfoToItem(item, data, curGameData) {
    const priceContainer = item.querySelector(".content-info-b");
    if (!priceContainer) {
      return;
    }

    const existingPriceInfo = priceContainer.querySelector(".steampy-info");
    if (existingPriceInfo) {
      return;
    }

    const steamPyInfo = document.createElement("div");
    steamPyInfo.className = "steampy-info";
    const titleEn = curGameData?.sku_names.en;
    let titlecheck = false;
    if (data && data.gameName !== titleEn && data.gameName !== curGameData?.sku_names.default) {
      console.log(`游戏名称不匹配：${data.gameName} != ${titleEn}`);
      titlecheck = true;
    }

    let formattedPrice;
    if (data.keyPrice === null) {
      formattedPrice = "N/A";
    } else {
      formattedPrice = data.keyPrice.toFixed(2);
    }

    steamPyInfo.innerHTML = `
        <div style="">
            <div style="color: #e53935; font-weight: 500;">
                SteamPy价格: ￥${formattedPrice}
            </div>
            <div style="color: #666;">
                销售者: ${data.keySales || 0}
            </div>
              <div style="color: #666;">
            交易量: ${data.keyTx || 0}
            </div>
        </div>
          ${titlecheck ? '<span style="color: #e53935;font-weight: 500;">名称不匹配 可能有误</span>' : ""}

    `;

    const buyNowButton = item.querySelector(".buy-now");
    if (buyNowButton && buyNowButton.parentNode) {
      buyNowButton.parentNode.insertBefore(steamPyInfo, buyNowButton);
    } else {
      priceContainer.appendChild(steamPyInfo);
    }

    console.log(`已为${data.gameNameCn || data.gameName}添加价格信息`);
  }

  function showSavedAppIds() {
    console.log("已保存的Steam AppID列表:", processedSkusDict);
  }

  function clearErrorFetchCache() {
    for (const skuId in processedSkusDict) {
      if (processedSkusDict[skuId] === null) {
        delete processedSkusDict[skuId];
      }
    }
    GM_setValue("processedSkus", processedSkusDict);
  }

  console.log("Sonkwo Steam AppID提取器已启动");
  GM_registerMenuCommand("查看已保存的Steam AppID", showSavedAppIds);
  GM_registerMenuCommand("清除错误缓存", clearErrorFetchCache);
}
