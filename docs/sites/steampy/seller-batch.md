# SteamPy 卖家批量上架

## 输入与预检

功能挂载于 `/pro/seller/sellerCDKey`。区域来自 `.area-wap > .qu-li-a`；切换区域后，已有预览失效。

输入为无表头 CSV，列顺序为 `gameName,key,appId,gameId`，每行 2 至 4 列。Key 必填，其他三列至少填写一项；AppID 和 gameId 使用十进制正整数字符串。带引号字段支持逗号及双写双引号，不支持跨行。

按 AppID 查找时，将其组成 `https://store.steampowered.com/app/<appId>/`，调用当前区域的 `saleKeyByUrl`；仅按名称查找时调用 `saleKeyByName`。查询参数均含 `pageNumber=1`、`pageSize=10`、`sort=id`、`order=asc`、`gameUrl`、`gameName`。

搜索结果必须只有一个候选。显式 gameId 与 AppID 查询结果冲突时，整批预检失败；重复 Key 也阻止提交。

## 区域接口

| 区域 | 标识 | 商品前缀 | 挂单前缀 |
| --- | --- | --- | --- |
| 国区 | `cn` | `/xboot/steamGame` | `/xboot/steamKeySale` |
| 俄罗斯区 | `ru` | `/xboot/ruSteamGame` | `/xboot/ruKeySale` |
| 全球区 | `us` | `/xboot/usSteamGame` | `/xboot/usKeySale` |
| 土区 | `tl` | `/xboot/tlSteamGame` | `/xboot/tlKeySale` |

挂单前请求当前区域的 `GET <挂单前缀>/listSale`。参数为 `gameId`、`pageNumber=1`、`pageSize=20`、`sort=keyPrice`、`order=asc`，日期范围为空。第一条记录的 `keyPrice` 原值作为销售价；没有挂单价格时，预检失败。

## 提交

普通 CD-Key 上架使用 `POST <挂单前缀>/startSell`，编码为 `application/x-www-form-urlencoded`。表单包含 `gameId`、`keys`、`keyWord`、`sellPrice`、`syncUs`：

- `gameId` 使用 `steamGame.id`，同商品的 Key 合并为一个分组。
- `keys` 每行一个 Key。
- `keyWord` 为空，`syncUs="0"`，关闭全球区联动。

分组串行提交，当前实现从上次请求完成起至少等待 10.5 秒。普通分组失败后继续；令牌失效后停止剩余分组。

实现位于 `src/lib/steampy/steampy-plus-seller-batch.js` 和 `src/lib/steampy/xboot-client.js`。
