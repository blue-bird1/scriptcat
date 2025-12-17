// ==UserScript==
// @name         Sonkwo Steam AppID提取器
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  从Sonkwo商店搜索页面提取游戏的Steam AppID并保存
// @author       豆包编程助手
// @match        https://www.sonkwo.hk/store/search*
// @match        https://steampy.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @require      https://scriptcat.org/lib/637/1.4.8/ajaxHooker.js#sha256=dTF50feumqJW36kBpbf6+LguSLAtLr7CEs3oPmyfbiM=
// @connect      www.sonkwo.hk
// @connect      steampy.com
// ==/UserScript==

(function () {
    'use strict';

    const currentUrl = document.location.href;
    if (currentUrl.includes('steampy.com/')) {
        const accessToken = window.localStorage.getItem('accessToken');
        if (accessToken) {
            GM_setValue('accessToken', accessToken);
            console.log('[SteamPY价格脚本] 已同步SteamPY的AccessToken');
        }
        return; // 在steampy页面不继续执行后续逻辑
    }

    ajaxHooker.hook(request => {
        // 处理原有接口
        if (request.url.startsWith('https://www.sonkwo.cn/api/search/skus.json')) {
            request.response = (res) => {
                try {
                    const data = JSON.parse(res.responseText);
                    processGameData(data);
                } catch (e) {
                    console.error('解析steampy API(XHR)数据失败：', e);
                }
            };
        }
        return request;
    });

    let gameData = {};

    function processGameData(data) {
        const skus = data.skus;
        for (const sku of skus) {
            const appid = sku.id;
            if (appid) {
                gameData[appid] = sku;
            }
        }
    }
    // 配置参数
    const CONFIG = {
        // 关键：替换为你的有效 accesstoken（参考请求中的值，过期需重新获取）
        ACCESS_TOKEN: GM_getValue('accessToken', ''),
        PAGE_SIZE: 10,  // 每页返回数量（默认10，可调整）
        DEFAULT_PAGE: 1 // 默认查询第1页
    };


    function showError(message) {
        console.error(message);
    }

    /**
     * 异心函数：查询游戏价格数据
     * @param {string} gameName - 游戲名（中文/英文）
     * @param {number} pageNumber - 页码
     * @param {number} pageSize - 每页数量
     * @returns {Promise<void>}
     */
    async function fetchGamePrice(gameName) {
        // 1. 构建请求URL（对游戏名进行URL编码，处理中文）
        const requestUrl = new URL("https://steampy.com/xboot/steamGame/saleKeyByName");
        requestUrl.searchParams.set("pageNumber", 1);
        requestUrl.searchParams.set("pageSize", 10);
        requestUrl.searchParams.set("sort", "id");
        requestUrl.searchParams.set("order", "asc");
        requestUrl.searchParams.set("gameUrl", "");
        requestUrl.searchParams.set("gameName", gameName); // 中文编码

        try {

            console.log(`request ` + requestUrl.toString());

            // 2. 发起GM请求（比fetch更稳定，支持油猴跨域配置）
            const response = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "GET",
                    url: requestUrl.toString(),
                    headers: {
                        "accept": "application/json, text/plain, */*",
                        "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
                        "accesstoken": CONFIG.ACCESS_TOKEN, // 关键凭据
                        "app_token": "",
                        "sec-ch-ua": "\"Chromium\";v=\"140\", \"Not=A?Brand\";v=\"24\", \"Google Chrome\";v=\"140\"",
                        "sec-ch-ua-mobile": "?0",
                        "sec-ch-ua-platform": "\"Windows\"",
                        "sec-fetch-dest": "empty",
                        "sec-fetch-mode": "cors",
                        "sec-fetch-site": "same-origin",
                        "sec-gpc": "1",
                        "referrer": "https://steampy.com/pyUserInfo/sellerCDKey" // 模拟真实请求来源
                    },
                    credentials: "include", // 携带Cookie（参考原请求）
                    anonymous: false, // 保留凭据（与credentials配合）
                    responseType: "json", // 直接解析JSON响应

                    // 3. 成功回调：处理返回数据
                    onload: (response) => resolve(response),

                    // 5. 错误回调：处理网络/连接错误
                    onerror: (error) => reject(error),

                    onabort: () => reject("请求被中止")
                });
            });

            // 检查HTTP状态码
            if (response.status < 200 || response.status >= 300) {
                showError(`请求失败！HTTP状态码：${response.status}`);
                return;
            }

            const resultData = response.response;
            // 检查业务状态（success: true）
            if (!resultData.success || resultData.code !== 200) {
                showError(`业务请求失败：${resultData.message || "未知错误"}`);
                // 特殊提示：accesstoken过期（常见错误）
                if (resultData.message?.includes("token") || resultData.code === 401) {
                    alert("提示：accesstoken可能已过期，请在脚本 CONFIG 区更新有效token！");
                }
                return;
            }

            // 4. 解析并展示价格数据
            return resultData.result
        } catch (error) {
            showError(error)
            showError(`网络请求错误：${error.message || "无法连接到SteamPy服务器"}`);
        }
    }


    var processedItems = new Set();

    const observer = new MutationObserver((mutations) => {
        // 遍历每一个变化记录（关键修复：在循环内部处理所有类型）
        mutations.forEach((mutation) => {
            // 1. 处理新增节点（原逻辑保留，优化重复处理）
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach((node) => {
                    // 节点本身是.sku-list-item
                    if (node.nodeType === 1 && node.classList.contains('sku-list-item')) {
                        if (!processedItems.has(node)) {
                            processSkuItem(node);
                            processedItems.add(node);
                        }
                    }

                    // 子节点中包含.sku-list-item
                    if (node.nodeType === 1) {
                        const skuItems = node.getElementsByClassName('sku-list-item');
                        Array.from(skuItems).forEach(item => {
                            if (!processedItems.has(item)) {
                                processSkuItem(item);
                                processedItems.add(item);
                            }
                        });
                    }
                });
            }

            // 2. 处理文本内容变化（移到循环内部，修复判断对象）
            if (mutation.type === 'characterData' && mutation.target.parentNode) {
                const skuItem = mutation.target.parentNode.closest('.sku-list-item');
                if (skuItem && processedItems.has(skuItem)) {
                    console.debug('处理文本内容变化', skuItem);
                    processSkuItem(skuItem);
                }
            }

            // 3. 处理属性变化（移到循环内部，修复判断对象）
            if (mutation.type === 'attributes') {
                const skuItem = mutation.target.closest('.sku-list-item');
                if (skuItem && processedItems.has(skuItem)) {
                    console.debug('处理属性变化', skuItem);
                    processSkuItem(skuItem);
                }
            }
        });
    });

    window.addEventListener('load', () => {
        console.log("加载完成 加载观察者");
        observer.observe(document.querySelector("#background_inner > div > div > div.search-left"), {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
        });
    })


    // 存储已处理的SKU链接，避免重复处理
    const processedSkusDict = GM_getValue('processedSkus', {});


    async function getGameData(skuId, title) {
        if (processedSkusDict[skuId] !== undefined) {
            console.debug("重复处理，跳过" + skuId + " " + title);
            const data = processedSkusDict[skuId];
            return data;
        } else {
            console.debug(`处理SKUid：${skuId} SKU标题：${title}`);
            const data = await fetchGamePrice(title);
            if (data) {
                // 将数据存储到GM
                // check data.content
                if (data.content && data.content.length > 0) {
                    const matchedGameData = data.content.find(game => game.gameName === title);
                    processedSkusDict[skuId] = matchedGameData || data.content[0];
                    GM_setValue('processedSkus', processedSkusDict);
                    return matchedGameData ? matchedGameData : data.content[0] || null;
                } else {
                    processedSkusDict[skuId] = null;
                    GM_setValue('processedSkus', processedSkusDict);
                }
            } else {
                console.log("获取数据失败 skuid:" + skuId + "  title:" + title);
                processedSkusDict[skuId] = null;
                GM_setValue('processedSkus', processedSkusDict);
            }
        }
        return
    }


    // 处理单个SKU项目
    async function processSkuItem(item) {
        // 提取链接元素
        const linkElement = item.querySelector('a.listed-game-block');
        if (!linkElement) return;

        // 获取SKU详情页链接
        const skuUrl = linkElement.getAttribute('href');
        // sku url to sku id example /sku/1111 to 1111
        const skuId = skuUrl.split('/').pop();
        // const title = linkElement.querySelector('.title').textContent.trim();
        const skuIdInt = parseInt(skuId, 10);
        const curGameData = gameData[skuIdInt];
        const titleEn = curGameData?.sku_names.en;

        try {
            // 获取游戏数据（假设getGameData是异步函数，需要用await）
            const data = await getGameData(skuId, titleEn);

            // 确保数据有效
            if (data && data.keyPrice !== undefined) {
                // 为项目添加SteamPy价格信息
                addPriceInfoToItem(item, data, curGameData);
            } else {
                console.log(`未找到${titleEn}的价格数据`);

            }
        } catch (error) {
            console.error(`处理${titleEn}时出错:`, error);
        }

    }

    /**
 * 为游戏项添加SteamPy价格信息
 * @param {HTMLElement} item - 游戏列表项元素
 * @param {Object} data - SteamPy返回的游戏数据
 */
    function addPriceInfoToItem(item, data, curGameData) {
        // 找到价格信息容器
        const priceContainer = item.querySelector('.content-info-b');
        if (!priceContainer) return;

        // check if price info already exists
        const existingPriceInfo = priceContainer.querySelector('.steampy-info');
        if (existingPriceInfo) return;

        // 创建新的信息容器
        const steamPyInfo = document.createElement('div');
        steamPyInfo.className = 'steampy-info';
        // check gamename and title same
        const titleEn = curGameData?.sku_names.en;
        let titlecheck = false;
        if (data && data.gameName !== titleEn && data.gameName !== curGameData?.sku_names.default) {
            console.log(`游戏名称不匹配：${data.gameName} != ${titleEn}`);
            titlecheck = true
        }
        let formattedPrice;
        // 格式化价格显示（保留两位小数）
        if (data.keyPrice === null) {
            formattedPrice = 'N/A';
        } else {
            formattedPrice = data.keyPrice.toFixed(2);
        }


        // 构建信息内容
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
          ${titlecheck ? `<span style="color: #e53935;font-weight: 500;">名称不匹配 可能有误</span>` : ''}

    `;

        // 将新信息添加到价格区域下方
        const buyNowButton = item.querySelector('.buy-now');
        if (buyNowButton && buyNowButton.parentNode) {
            // 插入到"立即购买"按钮之前
            buyNowButton.parentNode.insertBefore(steamPyInfo, buyNowButton);
        } else {
            // 备选位置：添加到价格容器末尾
            priceContainer.appendChild(steamPyInfo);
        }

        console.log(`已为${data.gameNameCn || data.gameName}添加价格信息`);
    }



    // 显示已保存的AppID列表
    function showSavedAppIds() {
        const skus = processedSkusDict;
        console.log('已保存的Steam AppID列表:', skus);
    }

    function clearErrorFetchCache() {
        // for  processedSkusDict[skuId] clear null value
        const skus = processedSkusDict;
        for (const skuId in skus) {
            if (skus[skuId] === null) {
                delete processedSkusDict[skuId];
            }
        }
        GM_setValue('processedSkus', processedSkusDict);
    }


    console.log('Sonkwo Steam AppID提取器已启动');
    GM_registerMenuCommand("查看已保存的Steam AppID", showSavedAppIds);
    GM_registerMenuCommand("清除错误缓存", clearErrorFetchCache);


})();
