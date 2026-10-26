# SteamPy 商品列表与筛选

## 原生列表

主列表接口按地区区分：

| 地区 | 路径 |
| --- | --- |
| cn | `GET /xboot/steamGame/keyHot` |
| ru | `GET /xboot/ruSteamGame/keyHot` |
| us | `GET /xboot/usSteamGame/keyHot` |
| tl | `GET /xboot/tlSteamGame/keyHot` |

默认 `pageSize=30`。页面 `cdkListApi(searchForm)` 返回 envelope，列表在 `result.content`，分页字段为 `result.totalPages`、`result.totalElements`。`searchForm` 含 `pageNumber`、`pageSize`、`sort`、`order`、`startDate`、`endDate`。

已有站点样本确认 `pageSize=100` 返回 100 条；该值不是已确认的最大上限。Vue 3 主实例通过 `searchForm.pageSize`、`changePageSize`、`changePage` 和 `getGameList` 管理分页，主分页器没有页大小选择器。

## 高级筛选契约

`GET /xboot/pyFilter/list` 返回以下 15 组字段：

| 类型 | 字段 |
| --- | --- |
| `decRange` | `lowAmt/highAmt`、`lowDis/highDis`、`lowVs/highVs`、`lowRating/highRating` |
| `intRange` | `lowReview/highReview` |
| `int` | `kd`、`releaseDay` |
| `str` | `hisFlag`、`genre`、`reviewScoreDesc`、`lang`、`familySharing`、`deckVerified`、`cards`、`publisher` |

每组包含 `name`、`code`、`highCode`、`type`、`sortOrder`、`showFlag`、`options`；选项包含 `label`、`lowValue`、`highValue`、`strValue`、`sortOrder`、`showFlag`。`showFlag` 控制展示，`sortOrder` 控制同层排序。

`GET /xboot/steamApp/list` 接收上述字段及 `pageNumber`、`pageSize`、`sort`、`order`。未选字段传空字符串；小数范围保留两位小数，整数值传整数字符串；排序使用 `sort=sp.keyDaily&order=desc`。

## 商品模型差异

高级筛选响应是 Spring 分页对象，商品位于 `result.content[]`。记录含 `appId`、`miniPrice`、`oriPrice`，不含 `steamApp.type`。

脚本将 `miniPrice` 映射为 `keyPrice`；价格有效且 `oriPrice > 0` 时，`keyDiscount=miniPrice/oriPrice`。这些记录不提供 `keyTxAmt`、`keySales`、`gameUrl` 或 `id`，不能按原生商品对象补造这些字段。

高级筛选期间，隐藏 DLC 控件暂停并禁用；退出后恢复原勾选状态。价格与忽略过滤仍然生效。已拥有游戏是否显示沿用筛选栏「隐藏已拥有」，默认隐藏；高级筛选不会暂停这个开关。

实现位于 `src/lib/steampy/steampy-plus-advanced-filter.js`。
