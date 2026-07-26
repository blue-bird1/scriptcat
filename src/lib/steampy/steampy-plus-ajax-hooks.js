export function installSteamPyAjaxHooks({ ajaxHooker, jQuery, onHotGames }) {
  ajaxHooker.hook((request) => {
    if (request.url.includes("/xboot/steamGame/keyHot")) {
      request.response = (response) => {
        try {
          const data = JSON.parse(response.responseText);
          onHotGames(data);
          response.responseText = JSON.stringify(data);
        } catch (error) {
          console.error("keyHot接口数据处理失败：", error);
        }
      };
    } else if (request.url.includes("/xboot/steamGame/getOne")) {
      request.response = (response) => {
        try {
          const data = JSON.parse(response.responseText);
          if (data.code !== 200 || data.success !== true) {
            console.log("getOne接口数据处理失败：", data);
            return;
          }
          const target = jQuery(".market-content > .market-detail > div:nth-child(3)");
          if (!target.find("[data-steam-py-plus-sales]").length) {
            const historicalSales = data.result.keySales;
            const historicalSalesText = historicalSales === undefined || historicalSales === null || historicalSales === ""
              ? "暂无"
              : String(historicalSales);
            target.append(`<div data-steam-py-plus-sales class="ht100 mt-50" style="flex-wrap: wrap;"><span class="f20-rem mt-20-rem ml-20-rem">历史销售数量 ${historicalSalesText}</span></div>`);
          }
        } catch (error) {
          console.error("getOne接口数据处理失败：", error);
        }
      };
    }
    return request;
  });
}
