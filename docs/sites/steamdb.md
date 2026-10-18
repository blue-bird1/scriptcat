# SteamDB 中键打开 Steam 商店

2026-09-11 页面样本确认以下结构：

| 页面区域 | AppID 来源 |
| --- | --- |
| 即时搜索 | `ol.ais-Hits-list` 内 `li.ais-Hits-item` 的 `a[data-appid]` |
| 促销表 | `table.table-sales tr[data-appid]` |
| 促销页表外推荐 | `a.app[data-appid]` |

即时搜索中的游戏链接通常指向 SteamDB 自身的 `/app/` 页面；促销行还包含已有的商店图标链接。脚本以 `data-appid` 构造 `https://store.steampowered.com/app/<appId>/`，不依赖点击位置上的 href。

事件绑定在 `document` 捕获阶段的 `mousedown`、`auxclick`，因此 Algolia 或 DataTables 重绘列表后仍生效。仅无修饰键的中键触发打开操作。

实现位于 `src/lib/steamdb/open-steam-store.js`。
