import { expect, test } from "./steampy-sale-start-time.fixture.mjs";

const DETAIL_URL = "https://steampy.com/pro/cdKey/cdkDetail?name=cn&gameId=765014032267612160";
const START_TIME_HEADER = "开始销售时间";

function saleRow(page, saleId) {
  return page.locator("tr", { hasText: saleId });
}

test("SteamPy Plus 销售时间在真实详情页分页和 SPA 往返后保持正确", async ({
  page,
  userscriptSession,
}) => {
  await page.goto(DETAIL_URL, { waitUntil: "domcontentloaded" });

  const table = page.locator("table", { has: page.getByRole("columnheader", { name: START_TIME_HEADER }) });
  const redirectedToLogin = page.waitForURL(/\/pro\/login/, { timeout: 15_000 }).then(() => {
    throw new Error(
      "The copied ScriptCat source profile is not authenticated with SteamPy. Log in through chrome-devtools-scriptcat, close that browser, and rerun this E2E.",
    );
  });
  await Promise.race([
    table.getByRole("columnheader", { name: START_TIME_HEADER }).waitFor(),
    redirectedToLogin,
  ]);
  await expect(table.getByRole("columnheader", { name: START_TIME_HEADER })).toHaveCount(1);
  await expect(saleRow(page, "K9001093910454993440768")).toContainText("2026-07-27 05:01:57");
  await expect(saleRow(page, "9000985793395086954496")).toContainText("2025-10-01 20:43:21");
  await expect(saleRow(page, "K9001093910454993440768").locator("img")).toHaveAttribute(
    "src",
    /scriptcat-e2e-k900\.jpg$/,
  );
  expect(userscriptSession.listSaleResponseCount.value).toBe(1);

  const secondListSaleResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/xboot/steamKeySale/listSale" &&
      userscriptSession.listSaleResponseCount.value >= 2,
  );
  await page.locator(".ivu-page-next").click();
  await secondListSaleResponse;
  expect(userscriptSession.listSaleResponseCount.value).toBe(2);
  await expect(saleRow(page, "K900123456789012345678")).toContainText("暂无");
  await expect(saleRow(page, "123456789012345678")).toContainText("暂无");

  await page.evaluate(async () => {
    const router = document.querySelector("#app")?._vnode?.component?.proxy?.$router;
    if (!router?.push) throw new Error("SteamPy router is unavailable on the CDKey detail page.");
    await router.push("/seller/sellerCDKey");
  });
  await expect(page).toHaveURL(/\/seller\/sellerCDKey$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/pro\/cdKey\/cdkDetail/);
  await expect(table.getByRole("columnheader", { name: START_TIME_HEADER })).toHaveCount(1);
  await expect(saleRow(page, "K9001093910454993440768")).toContainText("2026-07-27 05:01:57");
});
