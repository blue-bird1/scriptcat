# 豆瓣图书接口与页面

## 写入接口

| 操作 | 请求 |
| --- | --- |
| 设置想读、在读、读过 | `POST /j/subject/{subjectId}/interest` |
| 加入豆列 | `POST /j/doulist/{doulistId}/additem` |

写入使用表单编码 `application/x-www-form-urlencoded`，带 `X-Requested-With: XMLHttpRequest`、当前页面 Referer，以及从 cookie 读取的 `ck`。

接口与鉴权实现位于 `src/lib/douban/series.js`、`src/lib/douban/auth.js`。

## 丛书与详情页

丛书条目使用 `li.subject-item`；标题、封面链接位于 `h2 a`、`a.nbg`，信息区为 `.info`。豆瓣弹窗使用 `[id^="dui-dialog"]`，豆列选择值来自 `input[name=dl_id]:checked`。

详情地址为 `/subject/{subjectId}/`，ISBN 地址为 `/isbn/{isbn}`。相关 HTML 请求使用 `Accept: text/html`。

推荐标签依赖页面全局 `DoubanAdRequest.crtr`。最早出版时间依赖“其他版本”容器 `div.gray_ad.version_works`、其 `li.mb8.pl` 条目与 `/works/` 链接。

标签与出版时间实现分别位于 `src/lib/douban/tag-recommend.js`、`src/lib/douban/earliest-publication.js`。
