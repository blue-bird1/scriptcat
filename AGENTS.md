# scriptcat

## 身份

我是 scriptcat 的维护者。scriptcat 是类 Tampermonkey 的浏览器插件，脚本在此运行。本仓库是一组用户脚本，针对豆瓣、SteamPy、keylol、Z-Library、Bilibili 等站点。目标站点几乎不提供公开 API。维护者即使用者：脚本给自己和他人用，需对代码质量与对站点的真实理解负责。默认必读规则见 [scriptcat-context.mdc](.cursor/rules/scriptcat-context.mdc) 与 [scriptcat-workflow.mdc](.cursor/rules/scriptcat-workflow.mdc)。

## 视角

- **维护者即使用者**：脚本是给自己和别人用的，自己也是调用方；以「自己会用的」视角对待 UI/UX，写完不等于结束。
- **对代码负责**：维护者要对质量、兼容与安全负责；出错时说明原因和下一步，帮用户恢复，而非只抛错。
- **立场**：我即维护者（不是客服、不是教程作者），语气与决策与之一致。

## 油猴脚本本质与发布维护

- **本质**：油猴脚本是对站点 UI、UX 与功能的改进；必须建立对站点的真实理解（结构、接口、选择器），不瞎猜。
- **发布与责任**：一份代码对应多用户、多环境；发布渠道（如 Greasy Fork）、@version、更新说明、用户反馈形成闭环。不随便加依赖、不破坏现有用户、合规与安全由维护者负责。

## ScriptCat 浏览器验证与安装

- **本地 managed 扩展**：`browser/scriptcat` 是本地 ScriptCat 扩展 submodule。它通过 `uv run --project scripts --python 3.12 python scripts/scriptcat/publish.py` 在本机构建、测试并发布。发布数据位于 `~/.local/share/scriptcat-extension`，固定物理扩展目录是 `~/.codex/chrome-extensions/scriptcat/managed`，扩展 ID 为 `oepcbpjafionmhhelohlfhlmlaciclhc`。
- **专用 MCP**：调试或验收本仓库 `*.user.js` 时，使用 `chrome-devtools-scriptcat`（工具命名空间通常为 `mcp__chrome_devtools_scriptcat__`）。MCP 位于 `~/.local/share/scriptcat-mcp/current/mcp/bin/chrome-devtools-mcp.js`，启动 browser provider 提供的 `~/.local/share/scriptcat-browser/current/chrome-linux/chrome`，并使用固定 profile `~/.codex/chrome-devtools-scriptcat-chromium-profile`。Chromium 通过 CDP pipe 以 headless 模式运行，页面流量使用本机 `http://127.0.0.1:7891` 代理。
- **运行时扩展读取**：MCP 从配置给定的 managed 目录读取扩展 manifest，不假设扩展版本，也不读取插件发布事务。扩展发布、browser provider 与 MCP 的安装状态彼此独立。
- **扩展状态与恢复**：先调用 `scriptcat_status`。`userScriptsAccessEnabled` 为 `false` 时，对固定 ID 调用 `set_extension_user_scripts_access` 并传入 `enabled=true`，再检查状态；`true` 无需操作，`null` 表示当前无法查询。固定扩展的通用生命周期操作及 `enabled=false` 均返回 `MANAGED_EXTENSION_PROTECTED`。managed 目录缺失、内容损坏、manifest 无效或扩展未就绪时，重新执行本地 publish 命令修复固定目录，再检查状态。
- **扩展 ID 迁移**：固定 ID `oepcbpjafionmhhelohlfhlmlaciclhc` 使用独立的新扩展存储，不迁移旧 ID `ckchkcgpbkhleahkgkbiiikpcjdbopje` 的脚本、设置或 storage。新 ID 首次启用时重新授权，并用 `scriptcat_upsert_script` 写入所需脚本；状态、CRUD 与真实页面注入验收通过后，卸载旧 ID，再把旧物理目录 `~/.codex/chrome-extensions/scriptcat/v1.3.2` 移动到 `/backup`。
- **MCP 脚本管理与验收**：以 `scriptcat_upsert_script` 写入仓库内规范化的目标 `*.user.js` 路径，并按需使用 `scriptcat_list_scripts`、`scriptcat_get_script`、`scriptcat_set_enabled` 和 `scriptcat_delete_script`。随后打开真实 `@match` 页面，确认注入、UI、控制台、网络请求和核心交互。
- **用户正常浏览器安装**：用户日常浏览器使用 ScriptCat 的默认 VSCode sync 端口 `8642`。使用 `pnpm install:scriptcat -- <script.user.js>` 推送脚本；不传脚本时默认安装 `greenmangaming-bundle-claim.user.js`。该路径独立于专用 MCP 验收。

## Browser Provider 与 MCP 远程发布

- **产品与执行主机**：browser provider 和 MCP 都在 `192.168.50.8` 上按 build、package、install 三阶段发布，制品由对应 remote wrapper 拉回本机激活。provider 负责 Chromium 补丁、协议测试和外部浏览器接口；MCP 负责 MCP 可执行文件。`browser/scriptcat` 不在远端构建，且不进入 MCP 的 build、archive 或 install。
- **本地发布的插件**：managed ScriptCat 由本机 publish 命令单独构建、测试并发布；它不属于 browser provider 或 MCP 制品。更新任一远程产品不会发布插件，发布插件也不会改变 provider 或 MCP 安装。
- **本地门禁**：远程 build 前，本地 `main` 必须干净；build 命令推送提交后的 `HEAD` 到 `origin/main`，并在返回后确认本地 `HEAD` 未变化。`gclient`、`gn`、`autoninja`、`ninja` 与其他 Chromium 构建命令仅由远程包装器执行；`.codex/config.toml` 的 `PreToolUse` hook 强制该规则。
- **provider 三阶段**：provider 使用 `browser/provider.lock.json` 和 `scripts/remote/provider/` 的 build、package、install 入口。其 component identity 只由 provider lock、build schema 与浏览器输入决定；package 依据 component 与 runtime inventory 生成 release，install 原子激活 `~/.local/share/scriptcat-browser/releases/<release-build-id>` 并维护 `current`/`previous`。
- **MCP 三阶段**：MCP 使用 `browser/mcp.lock.json` 和 `scripts/remote/mcp/` 的 build、package、install 入口。其 component identity、lock、manifest、build 目录、测试和 archive 独立于 provider；package 和 install 只处理 MCP 制品，install 原子激活 `~/.local/share/scriptcat-mcp/releases/<release-build-id>` 并维护 `current`/`previous`。
- **阶段与验收**：build、package、install 各自只执行所属阶段。provider build 覆盖 Chromium 补丁和 protocol tests；MCP build 覆盖 MCP；本地插件 publish 覆盖扩展构建与测试。三个产品就绪后，通过 MCP 完成外部浏览器调用、ScriptCat CRUD、真实页面注入和进程清理验收。

## 项目

- **脚本清单**：见下表。改脚本前查阅脚本头；新增或删除脚本时同步更新。
- **源码与产物**：带 build 的脚本，**只改 `src/userscripts/` 与 `src/lib/`，再 `pnpm build` 生成根目录 `*.user.js`**；不要直接改根目录产物（会被 build 覆盖）。
- **协作方式**：在 `main` 上直接开发，不走 PR；每完成可验收单元后 commit（含 `src/` 与 build 产物）。

**Build 分级**：已接入 = 已在 `src/userscripts/`；A/B = 计划迁入 build；C = 仅抽 lib；D = 维持根目录单文件。

| 脚本文件 | Build | 源码 | 目标站点 | 主要功能 |
|----------|-------|------|----------|----------|
| douban.user.js | 已接入 | `src/userscripts/douban.user.js` | book.douban.com/series/* | 豆瓣丛书批量操作、豆列、书单 |
| steampy-token-sync.user.js | 已接入 | `src/userscripts/steampy-token-sync.user.js` | steampy.com | SteamPy accessToken + Cookies 云端同步 |
| douban-tag.user.js | 已接入 | `src/userscripts/douban-tag.user.js` | book.douban.com/subject/* | 豆瓣图书自动推荐标签 |
| douban_earliest_publication.user.js | 已接入 | `src/userscripts/douban_earliest_publication.user.js` | book.douban.com/subject/* | 豆瓣图书最早出版时间标注 |
| greenmangaming-bundle-claim.user.js | 已接入 | `src/userscripts/greenmangaming-bundle-claim.user.js` | greenmangamingbundles.com order-claim | GMG 捆绑包 Steam key 复制与自动激活 |
| keylol_to_steampy_price.user.js | 已接入 | `src/userscripts/keylol_to_steampy_price.user.js` | keylol.com, steampy.com | Steam 价格及总价显示 |
| snokwo.user.js | 已接入 | `src/userscripts/snokwo.user.js` | sonkwo.hk, steampy.com | Steam AppID 提取 |
| zlib.isbn_highlight.user.js | 已接入 | `src/userscripts/zlib.isbn_highlight.user.js` | Z-Library 多域名 | 高亮缺失 ISBN 的书籍卡片 |
| steampy.user.js | 已接入 | `src/userscripts/steampy.user.js` | steampy.com | SteamPy 价格对比增强 |
| bilibili.user.js | C（lib 已抽） | — | bilibili.com 番剧 | BGM 评分显示；`src/lib/bilibili/bgm-rating.js` |
| page-agent.user.js | C（lib 已抽） | — | 通用 (*://*/*) | 自然语言操作网页；`src/lib/page-agent/gm-fetch.js` |
| zlib.user.js | D | — | Z-Library 多域名 | UI 增强 |
| keylolsign.user.js | D | — | keylol.com | 每日签到 |
| vue.user.js | D | — | 通用 (*://*/*) | scriptcat dev 调试 |

## 项目结构

| 路径 | 用途 |
|------|------|
| `src/userscripts/*.user.js` | **可 build 脚本的源码入口**（含 `@name` 等 metadata + ES module `import`） |
| `src/lib/userscript/` | 跨脚本通用库（GM API 封装、格式化、CAT 文件存储等） |
| `src/lib/<site>/` | 站点专用库（如 `douban/auth.js`、`steampy/token-sync.js`） |
| `*.user.js`（仓库根） | **安装/发布用产物**；有 build 源的由 `pnpm build` 生成，其余为手写单文件 |
| `.build/userscripts/` | esbuild 临时输出（可忽略，已在 gitignore） |
| `.upstream/scriptcat` | ScriptCat 扩展上游源码，用于核对安装、注入、service worker 与运行时行为 |
| `.upstream/scriptcat-vscode` | ScriptCat VSCode 插件上游源码，用于核对 VSCode sync 协议 |
| `browser/scriptcat` | 本地 ScriptCat 扩展 submodule；由 `scripts/scriptcat/publish.py` 构建、测试并发布到 managed 目录 |
| `scripts/build-userscripts.mjs` | 将 `src/userscripts/*.user.js` bundle 到仓库根同名文件 |
| `scripts/remote/provider/` | browser provider 的 build、package、install 三阶段入口 |
| `scripts/remote/mcp/` | ScriptCat MCP 的 build、package、install 三阶段入口 |
| `scripts/scriptcat/publish.py` | 本地构建、测试并发布 `browser/scriptcat` 到 `~/.codex/chrome-extensions/scriptcat/managed` |
| `scripts/remote/{doctor,build,package,install,build_install}.py` | 只返回迁移错误的旧顶层 CLI |
| `browser/provider.lock.json` | browser provider 的供应链 lock |
| `browser/mcp.lock.json` | ScriptCat MCP 的供应链 lock |
| `.codex/config.toml` | 配置外部 browser provider、派生 `chrome-devtools-scriptcat` MCP 与本地 Chromium 构建门禁 |
| `scripts/userscripts/install-to-scriptcat.mjs` | 推送本地 userscript 到用户正常浏览器 ScriptCat |
| `scripts/userscripts/lint.cjs` | 对根目录 `*.user.js` 跑 eslint-plugin-userscripts |
| `scripts/userscripts/lint-built.cjs` | 仅 lint build 产物（`src/userscripts` 对应根目录文件） |
| `docs/site-notes.md` | 站点逆向笔记（接口、选择器、鉴权方式） |
| `docs/troubleshooting.md` | 常见问题排查 |
| `docs/scriptcat-require.md` | Scriptcat @require、@connect、库格式 |

## Build 层（`src/` + esbuild）

适用于逻辑较多、需要复用 `src/lib/` 的脚本。共享代码通过 build **内联**到各脚本，脚本间无运行时 `@require` 依赖。

| 源码入口 | 主要 lib 依赖 |
|----------|----------------|
| `src/userscripts/douban.user.js` | `src/lib/douban/{auth,series}.js` |
| `src/userscripts/steampy-token-sync.user.js` | `src/lib/steampy/token-sync.js`，及 `src/lib/userscript/*` |
| `src/userscripts/douban-tag.user.js` | `src/lib/douban/tag-recommend.js` |
| `src/userscripts/douban_earliest_publication.user.js` | `src/lib/douban/earliest-publication.js` |
| `src/userscripts/greenmangaming-bundle-claim.user.js` | `src/lib/gmg/*`，`src/lib/userscript/gm-xhr.js` |
| `src/userscripts/keylol_to_steampy_price.user.js` | `src/lib/keylol/steampy-price.js`，`src/lib/steampy/{access-token,xboot-client}.js` |
| `src/userscripts/snokwo.user.js` | `src/lib/sonkwo/search-price.js`，`src/lib/steampy/{access-token,xboot-client}.js` |
| `src/userscripts/zlib.isbn_highlight.user.js` | `src/lib/zlib/bookcard-isbn.js` |
| `src/userscripts/steampy.user.js` | `src/lib/steampy/steam-library.js`，`src/lib/steampy/steampy-plus*.js`，`src/lib/steampy/game-manager.js` |

**C 级已抽 lib（入口仍为根目录单文件，待后续迁入 build）**

| 根目录脚本 | 已抽 lib |
|------------|----------|
| `bilibili.user.js` | `src/lib/bilibili/bgm-rating.js` |
| `page-agent.user.js` | `src/lib/page-agent/gm-fetch.js`（可复用 `src/lib/userscript/gm-xhr.js`） |

**约定**

- metadata（`// ==UserScript==` …）写在 `src/userscripts/<name>.user.js` 顶部；build 后原样保留在产物文件开头。
- 源码 body 使用 ES module `import`；esbuild 以 **IIFE、不 minify、无 sourcemap** 打包到根目录，保持可读。
- 通用能力放 `src/lib/userscript/`；站点业务放 `src/lib/<site>/`；入口文件尽量薄（metadata + `import` + 启动调用）。
- 新增 build 脚本：在 `src/userscripts/` 添加入口 → 按需加 lib → 更新 `.gitignore` 白名单 → 更新本表 → `pnpm build:check`。

**常用命令**

```fish
pnpm build:check                         # build 全部入口 + lint 产物
pnpm build                               # 仅 build
pnpm run lint:userscripts -- foo.user.js
pnpm install:scriptcat -- steampy-token-sync.user.js

# 本地发布 managed ScriptCat 扩展
uv run --project scripts --python 3.12 python scripts/scriptcat/publish.py

# browser provider 远程发布：fish 中显式按阶段执行
set provider_component_build_id (uv run --project scripts --python 3.12 python scripts/remote/provider/build.py)
set provider_archive /tmp/scriptcat-browser-portable.tar.zst
set provider_release_build_id (uv run --project scripts --python 3.12 python scripts/remote/provider/package.py --build-id $provider_component_build_id --output $provider_archive)
set provider_archive_sha256 (string trim < "$provider_archive.sha256")
uv run --project scripts --python 3.12 python scripts/remote/provider/install.py $provider_archive --lock browser/provider.lock.json --build-id $provider_release_build_id --archive-sha256 $provider_archive_sha256

# ScriptCat MCP 远程发布：fish 中显式按阶段执行
set mcp_component_build_id (uv run --project scripts --python 3.12 python scripts/remote/mcp/build.py)
set mcp_archive /tmp/scriptcat-mcp-portable.tar.zst
set mcp_release_build_id (uv run --project scripts --python 3.12 python scripts/remote/mcp/package.py --build-id $mcp_component_build_id --output $mcp_archive)
set mcp_archive_sha256 (string trim < "$mcp_archive.sha256")
uv run --project scripts --python 3.12 python scripts/remote/mcp/install.py $mcp_archive --lock browser/mcp.lock.json --build-id $mcp_release_build_id --archive-sha256 $mcp_archive_sha256
```

## 参考

[Tampermonkey 技能](.agents/skills/tampermonkey/SKILL.md) | [site-notes](docs/site-notes.md) | [troubleshooting](docs/troubleshooting.md) | [scriptcat-require](docs/scriptcat-require.md)
