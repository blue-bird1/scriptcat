# Z-Library 下载记录

站点将下载记录保存为 `localStorage.downloadedBooks`，结构为 `{id, isbn?, date?}[]`。`downloadedBooksUser` 标识所属用户，`downloadedBooksUpdated` 记录更新状态。

多账号同步使用这三项数据识别当前账号与更新状态。实现位于 `src/lib/zlib/download-history-sync.js`。
