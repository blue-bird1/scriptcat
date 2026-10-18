# SteamPy CD-Key 商品与销售记录

## 商品标识

Steam AppID、`steamApp` 记录 ID 和 `steamGame.id` 属于不同标识空间。

高级筛选卡片只有 AppID。进入 CD-Key 详情前，请求 `GET /xboot/steamGame/searchByAppId?appId=...`，取 `result.content[0].id` 作为 `gameId`，再进入 `cdkDetail` 路由并传递 `name=<areas>`。此过程不预请求 `steamGame/getOne`。

已有样本中，AppID `1332010` 对应 `steamGame.id=544943379352391680`；`steamApp/getDetail` 返回的 `result.steamAppDetail.id=455666546174332928` 不是该详情链使用的商品 ID。

详情接口为 `GET /xboot/steamGame/getOne?gameId=...`。历史销售数量在 `result.keySales`；`keyTxAmt` 和 `keyAveAmt` 是金额。数量字段缺失时，脚本显示“暂无”。

## 新版销售表

`/pro/cdKey/cdkDetail` 使用 Vue 3 组件 `cdkDetail` 的 `columns` 和 `data`。分页、页大小与排序会替换 `data`，不会重建整张表。

站点 `steamAva` 列仍使用 Vue 2 的 `h("Avatar", {props: {src}})` 形式，Vue 3 将其渲染为空的 `avatar` 标签。脚本仅替换该列的渲染函数，以 `row.steamAva` 创建标准图片。

## 创建时间

`listSale` 行含 `saleId`，不含 `createTime`。国区 `steamKeySale/listSelf` 与全球区 `usKeySale/listSelf` 的第一方样本确认以下编码：

1. 移除 `K900` 或 `900` 前缀。
2. 将剩余十进制 Snowflake 载荷右移 22 位。
3. 加上纪元 `1524291141000` 毫秒。

脚本按 `Asia/Shanghai` 展示时间。未验证的旧格式显示“暂无”，不猜测其他前缀或纪元。

实现位于 `src/lib/steampy/steampy-plus-sale-start-time.js`。
