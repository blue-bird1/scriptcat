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

原生项调用页面方法，保留其页码重置等行为。脚本项先退出已激活的高级筛选，再改写 `searchForm` 并刷新列表。

`keyTxAmt`、`keyAveAmt` 升序时接口把空值排在最前：`pageSize=100` 时约占前 19 页。脚本用二分查找定位第一个含非空值的页再展示；定位失败回退第 1 页。

高级筛选期间列表接口固定 `sort=sp.keyDaily`，因此脚本项会先关闭高级筛选。

实现位于 `src/lib/steampy/steampy-plus-sort-select.js`。
