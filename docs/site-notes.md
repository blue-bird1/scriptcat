# 站点接口与选择器

本页记录用户脚本依赖的站点接口、鉴权方式、响应契约和 DOM 选择器。

## Page Agent (page-agent.user.js)

- **来源**：基于 [alibaba/page-agent](https://github.com/alibaba/page-agent)，从源码自托管构建，入口已 patch 为无自动初始化。
- **构建**：`./scripts/build-page-agent.sh`（需 Node 20+、npm、`ulimit -n 65535` 若遇 EMFILE）。`vendor/page-agent.js` 提交到仓库。
- **@connect**：`raw.githubusercontent.com`（@require vendor 必须）；Demo API `page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run`；BYOK 常见：`api.openai.com`、`dashscope.aliyuncs.com`、`api.deepseek.com`、`api.anthropic.com`、`generativelanguage.googleapis.com`、`api.groq.com`、`api.x.ai`。自建或非常见 API 需在脚本头添加对应 `@connect`。
- **@require 格式**：参考 [scriptcat.org lib](https://github.com/scriptscat/lib)（ajaxHooker、ElementGetter），顶层 `var X = ...` 创建全局，主脚本用 `/* global X */` 并直接使用 `X`。
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

## Steam 商店探索队列 (store.steampowered.com)

- **页面与启动**：Steam 同时提供首页 React 探索队列和经典应用页队列。首页在 `https://store.steampowered.com/` 原 URL 内打开 `[role="dialog"]` 模态框；经典队列位于查询参数含 `queue=1` 的 `/app/<appid>/...` 页面。脚本覆盖 Steam 商店域，但仅在真实队列 DOM 出现后工作。自动筛选默认关闭，用户主动启用后才评估当前项目并执行操作。
- **筛选规则**：筛选器保存为规则集合；每条规则描述一个可比较字段及其条件，项目满足任一规则即命中（OR）。缺少规则所需数据的项目不命中并跳过，不以默认值、猜测值或失败响应代替数据。
- **项目数据**：首页队列通过 `IStoreService/GetDiscoveryQueue` 取得 AppID，并通过 `IStoreBrowseService/GetItems` 载入 `StoreItem`。脚本直接读取 Steam 页面已解码的 `window.StoreItemCache`；价格、免费状态、发行日期、评论数和好评率优先复用队列数据，其中评论口径跟随 Steam 当前的评测偏好，与首页评论悬浮提示一致。语言规则允许多选必须包含的语言；`GetAllLanguagesWithSomeSupport` 返回的语言只要任一项与所选语言相同，即表示该游戏至少以界面、字幕或完整音频中的一种形式支持玩家可读语言并予以保留。选择简体中文、繁体中文或 Steam 中国简体中文时，若 `GetShortDescription` 含 Han 字符，脚本直接判定为可读，不补载语言字段；其余项目缺少语言数据时，将 `include_supported_languages` 合并到缓存自身按需执行的 `QueueAppRequest`。语言数据仍未知时不自动忽略。其他缓存字段缺失时同样先由 `QueueAppRequest` 补齐，缓存不可用或字段仍缺失时才分别回退同源 `appdetails` 或 `appreviews`。经典 `?queue=1` 商品页读取当前页面展示的 `user_reviews_summary_row`：microdata `reviewCount` 提供评论数，`data-tooltip-html` 提供按整数显示的好评率。标签使用当前队列由同一 `StoreItem` 数据渲染的本地化标签文本。规则集合和自动筛选开关通过 `localStorage` 持久化，页面和队列切换后继续使用同一配置。
- **自动动作时序**：自动筛选命中后只触发当前队列的原生忽略控件；脚本不直接伪造忽略请求。忽略点击的当前事件派发完成后立即进入下一项，不等待忽略请求响应；未命中或数据缺失时停留当前项目。
- **首页模态框动作**：队列对话框包含 `dq=widget` 的 `/explore` 说明链接。当前卡片操作区由商店页面链接、愿望单按钮和忽略按钮依次组成；按钮的 `aria-label` 会随站点语言变化，因此按操作区内的位置识别，不依赖翻译文本。愿望单请求为 `POST /api/addtowishlist`，忽略请求为 `POST /recommended/ignorerecommendation`。脚本在 `document-start` 监控愿望单请求；响应成功且操作按钮的选中类稳定后，从尺寸和水平位置成对的轮播按钮中点击右侧按钮进入下一项。忽略点击则不进入响应等待队列，直接点击同一右侧按钮。
- **经典队列动作**：Steam 通过 `POST /api/addtowishlist` 处理 `#add_to_wishlist_area a.add_to_wishlist` 的操作；成功状态为 `#add_to_wishlist_area_success` 可见，失败状态为 `#add_to_wishlist_area_fail` 可见。忽略通过 `POST /recommended/ignorerecommendation/` 提交 `sessionid`、`appid`、`snr`、`ignore_reason`；忽略前控件为 `.queue_btn_ignore .queue_btn_inactive`，菜单项为 `#queue_ignore_menu_option_not_interested` 和 `#queue_ignore_menu_option_owned_elsewhere`。愿望单成功后点击 `#nextInDiscoveryQueue .btn_next_in_queue_trigger`；忽略点击在当前事件派发完成后直接点击该控件，不等待忽略请求响应。下一项控件由其所属的 `#next_in_queue_form` 提交并进入下一项。

## SteamPy (steampy.com)

- **@connect**：`steampy.com`、`store.steampowered.com`（steampy.user.js、keylol_to_steampy_price.user.js、snokwo.user.js）。
- **鉴权**
  - 价格与搜索接口使用 SteamPy 登录后 token，通过请求 Header `accesstoken` 传递。SteamPy Plus 与 snokwo 在站内读取 `localStorage.getItem("accessToken")`；snokwo 同时将 token 同步到 GM 存储，keylol_to_steampy_price 再通过 `GM_getValue("accessToken")` 使用该值。
- **Steam 库同步（SteamPy Plus）**
  - 登录态下先请求 `GET https://store.steampowered.com/dynamicstore/userdata/`，再解析响应中的 `rgOwnedApps`、`rgWishlist`、`rgOwnedPackages` 和 `rgIgnoredApps`。现代登录响应的 `rgIgnoredApps` 是以 AppID 字符串为键、状态值为值的对象；匿名或旧响应可能返回空数组。SteamPy Plus 将该对象的键转换为 ignored AppID 集合。
  - `rgOwnedPackages` 是不透明的 PackageID 列表，按原值保存；它不遵循 AppID 的正整数校验规则。
- **商品数据契约（SteamPy Plus）**
  - 商品筛选元数据来自 `GET https://steampy.com/xboot/pyFilter/list`。接口返回 15 组筛选字段：`lowAmt`/`highAmt`、`lowDis`/`highDis`、`hisFlag`、`lowVs`/`highVs`、`kd`、`genre`、`releaseDay`、`reviewScoreDesc`、`lowRating`/`highRating`、`lowReview`/`highReview`、`lang`、`familySharing`、`deckVerified`、`cards`、`publisher`。每组记录包含 `name`、`code`、`highCode`、`type`、`sortOrder`、`showFlag`、`options`；`options[]` 包含 `label`、`lowValue`、`highValue`、`strValue`、`sortOrder`、`showFlag`。`type` 只有 `decRange`、`intRange`、`str`、`int` 四种：前两种表示成对范围，后两种表示单值筛选。`showFlag` 控制字段或选项是否展示，`sortOrder` 控制同层级显示顺序。
  - 商品列表使用 `GET https://steampy.com/xboot/steamApp/list`。请求包含上述 15 组筛选字段、`pageNumber`、`pageSize`、`sort`、`order`；没有选择的字段传空字符串。`decRange` 值保留两位小数，`intRange` 与 `int` 值使用整数字符串，排序固定为 `sort=sp.keyDaily`、`order=desc`。响应是 Spring 分页对象，`result.content[]` 含 `appId`、`miniPrice`、`oriPrice`，但不含 `steamApp.type`。SteamPy Plus 浅拷贝每条记录，映射 `keyPrice=miniPrice`，并仅在 `miniPrice` 与正数 `oriPrice` 都有效时映射 `keyDiscount=miniPrice/oriPrice`；不伪造 `keyTxAmt`、`keySales`、`gameUrl` 或 `id`。高级筛选生效期间暂停并禁用依赖 `steamApp.type` 的隐藏 DLC 条件，退出后恢复原勾选状态与控件状态；价格、拥有和忽略过滤继续生效。
  - 商品卡片的 `appId` 不能直接作为 CD-Key 详情参数。点击高级筛选结果时调用 `GET https://steampy.com/xboot/steamGame/searchByAppId?appId=...`，取 `result.content[0].id` 作为 `steamGame.id`，再进入现有 `cdkDetail` 路由并传递 `name=<areas>`、`gameId=<steamGame.id>`；该链路不预请求 `steamGame/getOne`。例如 `appId=1332010` 对应 `steamGame.id=544943379352391680`。`steamApp/getDetail` 返回的 `result.steamAppDetail.id` 属于 `steamApp`（示例值 `455666546174332928`），不属于 `steamGame`，不能替代详情链中的 `steamGame.id`。
- **新版卖家批量上架（SteamPy Plus）**
  - 功能仅挂载于 `/pro/seller/sellerCDKey`。当前区域读取 `.area-wap > .qu-li-a` 的国区、俄罗斯区、全球区、土区文本，依次映射为 `cn`、`ru`、`us`、`tl`；预检后切换区域会使预览失效。
  - 输入是无表头 CSV `gameName,key,appId,gameId`，每行 2 至 4 列。`key` 必填，且 `gameName`、`appId`、`gameId` 至少填写一项；`appId` 和 `gameId` 按十进制正整数字符串处理。按 AppID 解析时构造 `https://store.steampowered.com/app/<appId>/` 并调用当前区域 `saleKeyByUrl`；按名称解析时调用当前区域 `saleKeyByName`，两者均只接受唯一候选。显式 `gameId` 与 AppID 解析结果不一致时整批预检失败。
  - 四区商品搜索前缀分别是 `/xboot/steamGame`、`/xboot/ruSteamGame`、`/xboot/usSteamGame`、`/xboot/tlSteamGame`；挂单前以相同区域的 `steamKeySale`、`ruKeySale`、`usKeySale`、`tlKeySale` 下 `listSale` 查询实时价格，参数为 `pageNumber=1`、`pageSize=20`、`sort=keyPrice`、`order=asc` 和空日期范围。第一条 `keyPrice` 原值即销售价；没有挂单时预检失败。
  - 普通 CD-Key 上架使用对应区域的 `POST /startSell`，请求体编码为 `application/x-www-form-urlencoded`。新版页面固定提交 `gameId`、`keys`、`keyWord`、`sellPrice`、`syncUs`；`gameId` 使用 `steamGame.id`，`keys` 按每行一个 Key 传递。批量功能以空 `keyWord` 和字符串 `"0"` 的 `syncUs` 明确关闭全球区联动，再按 `gameId` 分组串行提交；普通分组失败后继续，AccessToken 失效后停止剩余分组。鉴权沿用 SteamPy XBoot 请求头中的 `accesstoken` 与 `app_token`，响应经统一 envelope 校验后解包 `result`。
- **接口**
  - `GET https://steampy.com/xboot/steamGame/keyHot`：主游戏列表接口。主列表 `pageSize` 默认值为 30；响应使用 Spring 分页字段 `content`、`totalPages`、`totalElements`、`size`、`number`、`numberOfElements`、`first`、`last`、`empty`。服务端实际接受 `pageSize=100` 并返回 100 条，这是已验证值，不代表最大上限。
  - `GET https://steampy.com/xboot/steamGame/saleKeyByUrl`：按 Steam 商店链接查 Key 价格。参数：`pageNumber`、`pageSize`、`sort`、`order`、`gameUrl`、`gameName`。keylol_to_steampy_price.user.js。
  - `GET https://steampy.com/xboot/steamGame/saleKeyByName`：按游戏名查。参数同上，`gameUrl` 空、`gameName` 为中文/英文名。snokwo.user.js。
  - `GET https://steampy.com/xboot/common/plugIn/getGame?subId=...&appId=...&type=...`：getGame 价格/插件信息。keylol_to_steampy 中 getCdkDetailUrl：`steampy.com/cdkDetail?name=cn&gameId={gameId}`（仅作链接，不请求）。
- **主列表分页（Vue 3）**
  - 主 Vue 3 实例的 `searchForm.pageSize` 初始为 30，并通过 `changePageSize`、`changePage`、`getGameList` 处理分页请求与列表刷新。
  - 主分页器不提供 page-size 选择器；其他列表的独立 page-size 选项属于各自列表配置。
- **选择器（steampy.user.js）**
  - 标签页内容：`div.ivu-tabs-content div.flex-row.jc-space-flex-start.flex-wrap.w-auto`；游戏块：`.gameblock`；`.ivu-tabs-tabpane`。
  - 新版卖家操作栏：`.cdkTrade-layout > .w100.tc`；原生添加按钮按直属 `button` 的“添加CDKey”文本识别；当前区域：`.area-wap > .qu-li-a`。
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
