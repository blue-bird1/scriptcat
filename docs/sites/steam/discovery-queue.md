# Steam 探索队列

## 页面边界

首页 React 队列位于 `[role="dialog"]`，通过其中带 `dq=widget` 的 `/explore` 链接识别。经典队列位于带 `queue=1` 参数的 `/app/<appid>/...` 商品页。

规则以 OR 组合。未知或缺失数据不命中规则；自动筛选与自动继续均默认关闭，DLC 规则受自动筛选总开关控制。

## React 预筛选

`IStoreService/GetDiscoveryQueue` 提供 AppID，`IStoreBrowseService/GetItems` 提供 `StoreItem`。脚本克隆队列响应读取 AppID，将原始响应对象与字节交还 Steam，不改写网络响应。首页预览不触发忽略操作。

`QueueMultipleAppRequests` 完成后，脚本按响应顺序读取同一 `StoreItem` 缓存并评估规则。命中项通过 `POST /recommended/ignorerecommendation` 写入忽略列表；只有 HTTP 状态与响应成功标记均确认后，才从交付 React 的页面局部 AppID 数组移除该项。

整批均成功忽略时，脚本沿用原请求的认证参数，以 `rebuild_queue=true` 请求后续批次。服务端不再返回 AppID 时，交付当前 Steam React 队列使用的 summary 哨兵，避免原生空队列索引越界。

预筛选不调用 `SkipDiscoveryQueueItem` 或 impression 接口，因此未渲染项目不产生浏览记录。解析、缓存、规则评估或忽略写入失败时，项目保留并交给 Steam 原生流程。

## 数据补齐

| 数据 | 读取顺序与约束 |
| --- | --- |
| DLC | `GetAppType() === 4`；缺失时补 `include_basic_info`，仍未知时读取同源 `appdetails.type` |
| 价格、免费状态、发行日期、评论 | 优先队列数据；评论口径跟随 Steam 当前评测偏好；详情与评论分别回退到同源 `appdetails`、`appreviews` |
| 标签 | 按原顺序映射 `LocalizedTagNames2_<language>`；目录缺失时只请求一次 `IStoreService/GetTagList` 并写回 |
| 语言 | `GetAllLanguagesWithSomeSupport()`；所选中文语言可由含 Han 字符的短描述满足；同批其他缺失值通过一次 `QueueMultipleAppRequests({include_supported_languages: true})` 补齐 |
| 个人资料功能限制 | 最后串行请求 `IPlayerService/GetAchievementsProgress/v1/`，按 AppID 缓存；收到 429 后本页停止该检查，未知结果不命中 |

缓存字段缺失时先使用 `QueueAppRequest`。预筛选不可用时，对已渲染卡片执行后置筛选，未知项目保持可见。

## React 后置动作

忽略操作使用 Steam 原生控件，在点击事件派发后进入下一项。愿望单使用 `POST /api/addtowishlist`，响应成功且按钮选中类稳定后，才点击右侧轮播按钮。未命中或数据缺失时停留当前项。

每批末尾的 summary 卡可能预渲染在离屏位置。自动继续只作用于轮播当前项，且同时要求 Done 与 Continue 存在；仅有 Done 时停止。按钮按结构和位置识别，不依赖本地化 `aria-label`。

当前 Steam 评测组件会将已带括号的截断计数再次包裹，形成 `((306))`。脚本仅在队列对话框内将这类叶子文本恢复为 `(306)`。

## 经典队列

评论数取自 `user_reviews_summary_row` 的 `reviewCount`，整数好评率取自 `data-tooltip-html`。经典队列不执行 React 预筛选。

愿望单成功与失败分别由 `#add_to_wishlist_area_success`、`#add_to_wishlist_area_fail` 表示。忽略接口为 `POST /recommended/ignorerecommendation/`，提交 `sessionid`、`appid`、`snr`、`ignore_reason`；点击后立即前进，不等待响应。

`#nextInDiscoveryQueue .btn_next_in_queue_trigger` 通过 `#next_in_queue_form` 提交下一项。结束页通过 `.discover_queue_empty` 中的 `/explore/startnew/0/` 链接开始下一批。

实现位于 `src/lib/steam/discovery-queue.js`、`src/lib/steam/discovery-queue-prefilter.js` 和 `src/lib/steam/discovery-queue-store-items.js`。
