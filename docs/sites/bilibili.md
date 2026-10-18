# Bilibili 番剧的 Bangumi 评分映射

Bilibili season ID、media ID 与 Bangumi subject ID 不是同一标识。评分脚本从 Bilibili 页面数据取得 media ID，再通过映射记录的 `bili_id === "md" + mediaId` 找到 `bgm_id`。

映射资源来自 https://rhilip.github.io/BangumiExtLinker/data/anime_map.json ，由 `GM_getResourceText("BILI_BANGUMI_MAPPING")` 读取。

评分接口为 `GET https://api.bgm.tv/v0/subjects/{bangumiId}`。请求使用 `User-Agent: bluebird/userscript`、`Accept: application/json`，响应按 JSON 解析，评分及人数取自 `rating.score`、`rating.total`。

根脚本 `bilibili.user.js` 保留完整运行逻辑；`src/lib/bilibili/bgm-rating.js` 保存已抽出的映射、评分请求与缓存实现。
