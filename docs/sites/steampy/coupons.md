# SteamPy CDK 券

## 未使用券

卡券中心路由为 `/pro` 下的 `cardList`。未使用列表请求：

`GET /xboot/promoCode/listSelfNew`

已确认参数为 `pageNumber`、`pageSize`、`sort=createTime`、`order=desc`。卡券中心页大小选项为 9、18、27。响应列表在 `result.content`，总数在 `result.totalElements`。

未使用券对象使用 `codePrice` 作为本张券抵扣额，使用 `promoType.name`、`promoType.remark`、`promoType.type`、`promoType.area`、`promoType.gameId`。`promoType.txMini` 在券类型管理中的名称是交易额下限，默认 0。`promoType.promoPrice` 是券类型面额；随机券的实际抵扣额以 `codePrice` 为准。

`promoType.type=key` 表示 CDK 券。`promoType.area` 取值为 `cn`、`ru`、`us`、`tl`。`promoType.device` 取值为 0 全部、1 安卓、2 IOS、3 网页。`promoType.gameId` 为 `0`、空或缺失时不限定游戏。

## 下单时的可用券

CDK 下单页请求 `GET /xboot/promoCode/listSelfCanUse`。已确认参数为 `tradeType=key`、`tradeArea`、`gameId`、`txPrice`、`pageNumber`、`pageSize`。`tradeArea` 与详情地区一致，取值为 `cn`、`ru`、`us`、`tl`。

下单页选中券后，支付金额为挂单价减去 `codePrice`，余额抵扣另减余额。支付金额计算结果小于等于 0 时显示 0。该页面不读取 `txMini`。
