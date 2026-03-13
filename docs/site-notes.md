# 站点逆向笔记

Agent 探索站点 JS/Network 后，将逆向出的接口、选择器、鉴权方式等写入此处，供未来 Agent 自查。**每次探索到新信息时主动补充**。

以下基线从现有脚本代码归纳得出（未改脚本行为），便于后续修 bug、逆向下游 API 时先查此处。

## Page Agent (page-agent.user.js)

- **来源**：基于 [alibaba/page-agent](https://github.com/alibaba/page-agent)，从源码自托管构建，入口已 patch 为无自动初始化。
- **构建**：`./scripts/build-page-agent.sh`（需 Node 20+、npm、`ulimit -n 65535` 若遇 EMFILE）。`vendor/page-agent.js` 提交到仓库。
- **@connect**：Demo API `page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run`；BYOK 常见：`api.openai.com`、`dashscope.aliyuncs.com`、`api.deepseek.com`、`api.anthropic.com`、`generativelanguage.googleapis.com`、`api.groq.com`、`api.x.ai`。自建或非常见 API 需在脚本头添加对应 `@connect`。
- **customFetch**：LLM 请求通过 `gmFetch` 包装 `GM_xmlhttpRequest` 实现跨域，满足 `fetch` 调用约定（method、headers、body、signal、Response.ok/json/text）。

## 豆瓣 (book.douban.com)

- **@connect**：`book.douban.com`（douban.user.js）；`zh.1lib.sk`（douban.user.js 跳 Z-Library 搜索）。
- **接口**
  - `POST https://book.douban.com/j/subject/{subjectId}/interest`：丛书页「想读」等操作。Headers: `Content-Type: application/x-www-form-urlencoded`, `X-Requested-With: XMLHttpRequest`，需带 ck cookie / Referer。
  - `POST https://book.douban.com/j/doulist/{doulistId}/additem`：豆列加书。同上 headers + form data。
  - `GET` 任意 book.douban.com 页面：fetchPageHtml 抓 HTML（Accept: text/html），用于解析丛书列表、豆瓣详情等。
- **选择器（丛书页 /series/*）**
  - 页面标题：`h1` 或 `document.title`
  - 丛书列表项：`li.subject-item`；封面/标题链接：`a.nbg` 或 `h2 a`；信息区：`.info`；购物车相关：`.cart-actions`、`.cart-info`、`.doulist-add-btn-custom`
  - 弹窗：`[id^="dui-dialog"]`；豆列表单：`form`、`input[name=dl_id]:checked`
  - 内容标题：`#content > h1`
- **其他**
  - 豆瓣图书详情：`https://book.douban.com/subject/{subjectId}/`；ISBN 页：`https://book.douban.com/isbn/{isbn}`。
  - 前端依赖：`DoubanAdRequest.crtr`（douban-tag.user.js 提取推荐标签）；「其他版本」容器：`div.gray_ad.version_works`，条目 `li.mb8.pl`，works 链接 `a[href*="/works/"]`（douban_earliest_publication.user.js）。
  - 静态资源：dialog 等来自 `img1.doubanio.com`（见 douban.user.js 内 `dialog_js_url`、`doulist_dialog_js_url` 等）。

## Z-Library

- **@connect**：`book.douban.com`、`doubanio.com`（zlib.user.js）。
- **域名**：脚本匹配 `*.z-library.sk`、`*.z-lib.fm`、`*.z-lib.gs`、`*.1lib.sk` 等；跳转搜索使用 `zh.1lib.sk`。
- **接口**
  - `GET https://book.douban.com/isbn/{isbn}`：Z-Library 页内查豆瓣封面/信息（zlib.user.js）；response 用 HTML 解析。
  - `GET` doubanio.com：豆瓣封面图等资源（zlib.user.js 内 fetch 为 GET + responseType blob）。
- **选择器**
  - 书籍卡片：`z-bookcard`；带 isbn 属性：`z-bookcard[isbn]`；搜索结果容器：`#searchResultBox > div.resItemBoxBooks > z-bookcard`、`#searchResultBox > .book-item > z-bookcard`。
  - 书单/搜索：`div.booklist-main.active > div.booklist-searchline > z-dropdown`；列表头：`.booklist-header__options`。
  - 书籍详情页：`.book-title`、`.bookProperty.property_isbn`、`.bookDetailsBox`、`.book-actions-container`、`.book-actions-buttons > .book-details-button`；bookmark：`.bookmarks[data-book_id]`。
  - 高亮缺失 ISBN：`z-bookcard` 无 `isbn` 或 `isbn` 为空（zlib.isbn_highlight.user.js）。

## SteamPy (steampy.com)

- **@connect**：`steampy.com`、`store.steampowered.com`（steampy.user.js、keylol_to_steampy_price.user.js、snokwo.user.js）。
- **鉴权**
  - 价格/搜索接口需 Header：`accesstoken`（SteamPY 登录后 token）。snokwo 从 `localStorage.getItem('accessToken')` 读取并 GM_setValue 同步；keylol_to_steampy 用 `GM_getValue('accessToken')`（需在 steampy 站内先取得）。
- **接口**
  - `GET https://steampy.com/xboot/steamGame/saleKeyByUrl`：按 Steam 商店链接查 Key 价格。参数：`pageNumber`、`pageSize`、`sort`、`order`、`gameUrl`、`gameName`。keylol_to_steampy_price.user.js。
  - `GET https://steampy.com/xboot/steamGame/saleKeyByName`：按游戏名查。参数同上，`gameUrl` 空、`gameName` 为中文/英文名。snokwo.user.js。
  - `GET https://steampy.com/xboot/common/plugIn/getGame?subId=...&appId=...&type=...`：getGame 价格/插件信息。keylol_to_steampy 中 getCdkDetailUrl：`steampy.com/cdkDetail?name=cn&gameId={gameId}`（仅作链接，不请求）。
- **选择器（steampy.user.js）**
  - 标签页内容：`div.ivu-tabs-content div.flex-row.jc-space-flex-start.flex-wrap.w-auto`；游戏块：`.gameblock`；`.ivu-tabs-tabpane`。
  - 出售列表：`#main > div.main > div.single-page-con > div.single-page > div:has(.cdkTrade-layout)`；订单：`.orderOne.bg-white .list-item`；列表项价格：`div:nth-child(7)`。
  - 筛选/排序：`.flex-row > .c-point.flex-row.align-items-center`；排序按钮：`.ml-5-rem.c-point.tagBtn`；`.tag.flex-row.align-items-center`。
  - 表单容器：`#main > div.main > div.single-page-con > div > div`（Vue 实例 `__vue__`）。

## Keylol (keylol.com)

- **@connect**：`keylol.com`（keylolsign.user.js、keylol_to_steampy_price.user.js）。
- **接口**
  - `GET https://keylol.com`：首页 HTML，用于判断登录状态与签到结果。keylolsign 使用 ajax（scriptcat ajax.js，底层 GM_xmlhttpRequest）。
  - 签到：脚本不主动调签到 API，通过解析首页 HTML 中是否包含 `showDialog("你已获得今天的体力和蒸汽奖励", ...)` 判断「今日已签到」。
- **选择器**
  - 用户栏：`#nav-user-action-bar ul.list-inline`；未登录：`a[href*="member.php?mod=logging&amp;action=login"]`、`a[href*="member.php?mod=register"]`。
  - keylol_to_steampy：帖子内 Steam 链接 `a[href*="store.steampowered.com/app/"]`；引用块：`#postlist > [id^="post_"]:first-of-type .quote blockquote`；排除 `.showhide`、`.sff_collapse` 等。

## Bilibili 番剧

- **@connect**：`api.bgm.tv`（bilibili.user.js）。
- **接口**
  - `GET https://api.bgm.tv/v0/subjects/{bangumiId}`：BGM 条目信息（评分等）。Headers：`User-Agent: bluebird/userscript`、`Accept: application/json`；responseType: json。
- **选择器**：脚本在 bilibili.com 番剧页根据页面数据取 bangumiId 后请求 BGM API，具体 DOM 选择器见 bilibili.user.js 内逻辑。

## Sonkwo (www.sonkwo.hk)

- **@connect**：`www.sonkwo.hk`、`steampy.com`（snokwo.user.js）。
- **用途**：在 sonkwo 搜索页根据游戏名调用 SteamPY `saleKeyByName` 显示价格；SteamPY 的 accessToken 同步见上 SteamPy 小节。
- **选择器**：见 snokwo.user.js（store.search 等页面结构）。
