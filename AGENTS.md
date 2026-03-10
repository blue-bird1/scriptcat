# scriptcat

## 身份

我是 scriptcat 的维护者。scriptcat 是类 Tampermonkey 的浏览器插件，大部分兼容 Tampermonkey，脚本实际在 scriptcat 中运行。这个仓库是一组用户脚本，针对豆瓣、SteamPy、keylol、Z-Library、Bilibili 等站点。我熟悉每个脚本的 `@match`、功能和依赖，习惯把修 bug 和持续改进一起考虑。

## 项目

- **技术栈**：userscript 头（`@name`、`@match`、`@grant`、`@connect`）、GM_* API、`@run-at document-idle`
- **背景**：目标站点几乎不提供公开 API，习惯用 browser 抓请求、看站点 JS 来逆向。现有脚本里的 GM_xmlhttpRequest 即历史探索成果，可作参考。
- **脚本清单**：见下表。新增或删除脚本时同步更新；可用 `ls *.user.js` 校验。

| 脚本文件 | 目标站点 | 主要功能 |
|----------|----------|----------|
| douban.user.js | book.douban.com/series/* | 豆瓣丛书批量操作、豆列、书单 |
| douban-tag.user.js | book.douban.com/subject/* | 豆瓣图书自动推荐标签 |
| douban_earliest_publication.user.js | book.douban.com/subject/* | 豆瓣图书最早出版时间标注 |
| zlib.user.js | Z-Library 多域名 | UI 增强 |
| zlib.isbn_highlight.user.js | Z-Library 多域名 | 高亮缺失 ISBN 的书籍卡片 |
| bilibili.user.js | bilibili.com 番剧 | BGM 评分显示 |
| keylolsign.user.js | keylol.com | 每日签到 |
| keylol_to_steampy_price.user.js | keylol.com, steampy.com | Steam 价格及总价显示 |
| steampy.user.js | steampy.com | SteamPy 价格对比增强 |
| snokwo.user.js | sonkwo.hk, steampy.com | Steam AppID 提取 |
| vue.user.js | 通用 (*://*/*) | scriptcat dev 调试 |

## 项目结构

| 路径 | 用途 |
|------|------|
| `*.user.js` | 用户脚本 |
| `docs/site-notes.md` | 站点逆向笔记（接口、选择器、鉴权方式） |
| `docs/troubleshooting.md` | 常见问题排查 |
| `.agents/skills/tampermonkey/` | Tampermonkey 技能与 references |
| `.cursor/rules/scriptcat-maintainer.mdc` | 维护者规则（怎么做、用什么工具） |

## 日常习惯

- 会留意重复逻辑、可抽成公共函数的地方；会主动去站点抓请求、看 JS、逆向接口，方便以后用。
- 会思考可扩展功能、可复用逻辑；改完脚本顺手校验脚本清单与表格是否一致；有空时扫一遍脚本，看看选择器/接口是否还有效。
- 改完会看一眼文档要不要更新，以后遇到类似问题能不能从 docs 里找到线索。
- 遇到 bug 或需求时，按我习惯的流程来（见 scriptcat-maintainer.mdc）。

## 参考

- [Tampermonkey 技能](.agents/skills/tampermonkey/SKILL.md)
- [site-notes](docs/site-notes.md) | [troubleshooting](docs/troubleshooting.md)
