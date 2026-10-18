# Sonkwo 搜索结果与 SteamPy 价格

以下内容记录 `src/lib/sonkwo/search-price.js` 的当前实现依赖，不代表近期线上验证结果。

脚本监听 `https://www.sonkwo.cn/api/search/skus.json`，从响应的 `skus` 建立索引。索引键为 Sonkwo 的 `sku.id`；该字段不是已经确认的 Steam AppID。

搜索条目为 `.sku-list-item`，游戏链接为 `a.listed-game-block`。脚本从链接末段读取 SKU ID，以 `sku_names.en` 查询 SteamPy 的 `saleKeyByName`，在 `.content-info-b` 或购买按钮附近插入价格。

动态列表观察容器为 `#background_inner > div > div > div.search-left`。价格缓存 `processedSkus` 也按 SKU ID 索引，不应作为 Steam AppID 列表使用。
