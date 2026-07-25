export function createSteamPySellerController({ elmGetter, jQuery, getSaleList }) {
  let initialized = false;

  function addHistoricalPrice(modal, gameData) {
    const label = modal.find(".mt-15.f15.fw500 .color-red.f12-rem");
    if (!label.length || gameData?.hisPrice === null || modal.find(".his-price-tag").length) return;
    const historyPrice = document.createElement("span");
    historyPrice.className = "his-price-tag color-blue f12-rem ml-10";
    historyPrice.textContent = ` 历史最低价格: ￥${gameData.hisPrice.toFixed(2)}`;
    label.after(historyPrice);
  }

  async function updateModalSalePrice(gameData, vm) {
    try {
      const saleData = await getSaleList(gameData.id, { fresh: true });
      const lowestPrice = Number(saleData.result?.content?.[0]?.keyPrice);
      if (saleData.code !== 200 || !Number.isFinite(lowestPrice) || lowestPrice <= 0 || vm.gameId !== gameData.id) return;
      vm.keyPricePy = lowestPrice;
      vm.cdkPrice = Math.max(0.1, (Math.round(lowestPrice * 10) - 1) / 10);
    } catch (error) {
      console.error("[SteamPy Plus] 查询当前最低挂单价失败", error);
    }
  }

  async function startModalListener() {
    await elmGetter.get("#main > div.main > div.single-page-con > div > div");
    const vm = jQuery("#main > div.main > div.single-page-con > div > div").get(0)?.__vue__;
    if (!vm || vm.__steamPyPlusGoToChoosePatched) return;
    const originalGoToChoose = vm.goToChoose;
    if (typeof originalGoToChoose !== "function") return;
    vm.__steamPyPlusGoToChoosePatched = true;
    vm.goToChoose = function patchedGoToChoose(index) {
      originalGoToChoose.call(this, index);
      const gameData = this.modalGamList[index];
      this.$nextTick(() => {
        addHistoricalPrice(jQuery(".ivu-modal").filter(":visible"), gameData);
        updateModalSalePrice(gameData, this);
      });
    };
  }

  async function updateSellRows(vm) {
    await elmGetter.get(".orderOne.bg-white .list-item");
    jQuery(".orderOne.bg-white .list-item").each(async (index, item) => {
      const data = vm.sellList?.[index];
      const priceElement = item.querySelector("div:nth-child(7)");
      if (!data || !priceElement) return;
      const selfPrice = data.keyPrice;
      priceElement.innerText = `${selfPrice}`;
      priceElement.classList.remove("color-red");
      if (data.stock === 0) return;
      try {
        const saleData = await getSaleList(data.gameId);
        if (saleData.code !== 200) {
          console.error(saleData.msg);
          return;
        }
        const saleList = saleData.result?.content || [];
        const lowestPrice = saleList[0]?.keyPrice;
        if (lowestPrice === undefined || lowestPrice >= selfPrice) return;
        let order = 1;
        for (const seller of saleList) {
          if (seller.saleId === data.sellerId) break;
          if (seller.keyPrice < selfPrice) order += seller.stock;
        }
        if (order !== 1) {
          priceElement.classList.add("color-red");
          priceElement.innerText = `${selfPrice} 最低价${lowestPrice}`;
          priceElement.setAttribute("data-rawtext", `${selfPrice}`);
        }
      } catch (error) {
        console.error("[SteamPy Plus] 查询卖家报价失败", error);
      }
    });
  }

  async function startSellListListener() {
    const elements = await elmGetter.get("#main > div.main > div.single-page-con > div.single-page > div:has(.cdkTrade-layout)");
    const vm = elements?.[0]?.__vue__;
    if (!vm || vm.__steamPyPlusSellWatcher || typeof vm.$watch !== "function") return;
    vm.__steamPyPlusSellWatcher = true;
    vm.$watch("sellList", function onSellListChanged() {
      if (vm.sellList === undefined) return;
      this.$nextTick(() => updateSellRows(vm));
    }, { immediate: true });
  }

  async function addQuantitySort() {
    try {
      const parent = await elmGetter.get(".flex-row > .c-point.flex-row.align-items-center");
      if (!parent?.length) return;
      const buttons = parent.find(".ml-5-rem.c-point.tagBtn");
      if (!buttons.length || parent.find("[data-steam-py-plus-quantity-sort]").length) return;
      const attributes = {};
      jQuery.each(buttons.first()[0].attributes, (_, attribute) => {
        if (attribute.name.startsWith("data-v-")) attributes[attribute.name] = attribute.value;
      });
      const form = await elmGetter.get("#main > div.main > div.single-page-con > div > div");
      const formVm = form?.[0]?.__vue__;
      if (!formVm) return;
      const quantityButton = jQuery("<div>")
        .addClass("ml-5-rem c-point tagBtn")
        .attr(attributes)
        .attr("data-steam-py-plus-quantity-sort", "true")
        .append(jQuery("<span>").addClass("tag-title").text("数量").attr(attributes));
      const sortByStock = function sortByStock() {
        parent.find(".ml-5-rem.c-point.tagBtn").removeClass("active");
        jQuery(this).addClass("active");
        formVm.sellForm.sort = "stock";
        formVm.sellForm.pageNumber = 1;
        formVm.getSellData();
      };
      quantityButton.on("click", sortByStock);
      buttons.on("click", sortByStock);
      buttons.last().after(quantityButton);
    } catch (error) {
      console.error("添加\"数量\"排序按钮失败：", error);
    }
  }

  async function start() {
    if (initialized) return;
    await Promise.all([startModalListener(), addQuantitySort(), startSellListListener()]);
    initialized = true;
  }

  function cleanup() {
    initialized = false;
  }

  return { cleanup, start };
}
