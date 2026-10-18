# Z-Library 书籍组件与下载记录

## 书籍卡片

站点使用 `z-bookcard` 表示书籍，ISBN 来自其 `isbn` 属性。属性缺失或为空时，ISBN 高亮脚本标记该卡片。

搜索结果的已确认结构为 `#searchResultBox > div.resItemBoxBooks > z-bookcard` 与 `#searchResultBox > .book-item > z-bookcard`。

详情页的 ISBN 位于 `.bookProperty.property_isbn`，操作区使用 `.book-actions-container`、`.book-actions-buttons > .book-details-button`。下载列表中的书签入口为 `.bookmarks[data-book_id]`。

## 首页推荐

推荐封面位于 `z-masonry[source=recommend]`。条目在 light DOM 中呈现为 `a > z-cover`，组件将其渲染为 shadow DOM 的 `.item`。

过滤已下载封面时，只移除对应条目；沿封面向上删除多层父节点会误删整个 masonry 容器。

## 下载记录

站点将下载记录保存为 `localStorage.downloadedBooks`，结构为 `{id, isbn?, date?}[]`。`downloadedBooksUser` 标识所属用户，`downloadedBooksUpdated` 记录更新状态。

多账号同步实现位于 `src/lib/zlib/download-history-sync.js`；ISBN 卡片处理位于 `src/lib/zlib/bookcard-isbn.js`。

## 豆瓣信息补全

`zlib.user.js` 从 `GET https://book.douban.com/isbn/{isbn}` 解析 HTML 获取书籍资料；豆瓣封面通过 `GM_xmlhttpRequest` 以 blob 读取 `doubanio.com` 资源。
