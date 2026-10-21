# SteamPy 排序下拉框

功能默认关闭，通过 ScriptCat 菜单“排序下拉框”即时启停。开启后原生“最新 / 周销量 / 销量 / 折扣 / 价格”控件隐藏，合并为一个下拉框；关闭时恢复原生控件，不改变当前排序结果。

## 选项与参数

| 选项 | 实现 | 查询参数 |
| --- | --- | --- |
| 最新 | 原生 `newSort` | `createTime desc` |
| 周销量 | 原生 `weekSort` | `cdkCount desc` |
| 销量 | 原生 `saleSort` | `keyTx desc` |
| 折扣 | 原生 `disCountSort` | `keyDiscount asc` |
| 价格从低到高 | 原生 `priceUp` | `keyPrice asc` |
| 价格从高到低 | 原生 `priceDown` | `keyPrice desc` |
| 实付价从低到高 | 脚本 | `keyTxAmt asc` |
| 成交均价从低到高 | 脚本 | `keyAveAmt asc` |
| 好评率从高到低 | 脚本 | `rating desc` |

原生项调用页面方法，保留其页码重置等行为。脚本项会先退出已激活的高级筛选，再改写 `searchForm` 并刷新列表。

## 空值先验

`keyTxAmt`、`keyAveAmt` 升序时，接口把空值记录排在最前。本功能不额外发探测请求：

- 落点取已学习的“有值页”，其次是“空值页 + 1”，最后回退到空值比例估算（默认 0.093，来自实测）。
- 每次列表加载后按实际结果更新学习值：出现有值记录记为有值页，整页为空记为空值页。
- 落点整页为空时显示提示“本页无成交价数据，翻到下一页查看”，用户翻页后学习值随之修正。

空值行只隐藏对应卡片的 DOM，不修改 Vue 列表状态，因此与价格筛选互不覆盖。

实现位于 `src/lib/steampy/steampy-plus-sort-select.js`。
