# Z-Library 书单接口

以下响应在 2026-10-18 的 `z-library.sk`、`1lib.sk` 书单页面验证。

## 读取书单

`POST /papi/booklist/{id}/get-books/{page}?order=date_savedA` 返回 `books` 和 `pagination`：

- 书籍 ID 位于 `books[].book.id`。
- 条目顶层的 `readlist_books_id` 标识书单条目，不是书籍 ID。
- `pagination.next` 是下一页页码或 `false`。

`GET /papi/booklist/current-user/{bookId}` 返回当前用户的书单列表。参数为 `0` 时返回全部书单，`readlistBookId` 为 `null`；省略该参数会返回 404。站点组件 `z-booklists-browser` 使用这一带参数的接口。

## 添加书籍与限流

`GET /papi/booklist/{booklistId}/add-book/{bookId}` 添加书籍，成功响应含 `success: 1`。复制完成以全部添加请求成功为准，不以请求已发出为准。

站点 `UserBookmarks.addBookToBooklist` 使用成功、错误回调报告业务结果，其 Promise 不会因业务错误而拒绝，且封装不提供 HTTP 响应头。脚本直接使用 `fetch` 读取限流响应。

添加接口曾返回 HTTP 429、非 JSON 正文及 `Retry-After: 15`。脚本按响应中的整数秒等待，再重试同一请求；缺少整数秒时明确报错，不把该正文当作 JSON 解析。

## 页面挂载

语言筛选控件位于 `div.booklist-main.active > div.booklist-searchline > z-dropdown`，操作按钮挂载到 `.booklist-header__options`。

书单中的 `<z-bookcard createButton>`、`.readlist-create` 是添加书籍按钮，不参与书籍处理。

实现位于 `zlib.user.js`。
