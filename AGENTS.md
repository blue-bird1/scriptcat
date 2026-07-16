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

- **上游源码位置**：ScriptCat 扩展源码已在 `.upstream/scriptcat`，VSCode 插件源码已在 `.upstream/scriptcat-vscode`。调查 ScriptCat 安装、同步、权限、注入、service worker 或 VSCode sync 行为时，先读这两个本地 checkout，不要先外部搜索或猜测实现。`.upstream` 被仓库 ignore 规则隐藏，搜索时使用 `rg -u`。
- **专用 MCP**：调试或验收本仓库 `*.user.js` 时，默认使用 `chrome-devtools-scriptcat`（工具命名空间通常为 `mcp__chrome_devtools_scriptcat__`）。MCP 可执行文件位于 `~/.local/share/scriptcat-mcp/current/mcp/bin/chrome-devtools-mcp.js`，并启动浏览器 provider 提供的 `~/.local/share/scriptcat-browser/current/chrome-linux/chrome`。它固定使用 `~/.codex/chrome-devtools-scriptcat-chromium-profile`；Chromium 通过 CDP pipe 以 headless 模式运行，页面流量使用本机 `http://127.0.0.1:7891` 代理；普通 `chrome-devtools` MCP 不用于 userscript 注入验收。
- **产品边界**：浏览器 provider 负责 Chromium 补丁、协议测试和外部浏览器接口；ScriptCat MCP 负责其可执行文件、固定 profile 锁、managed ScriptCat 的 ID、路径、版本、启用状态与调用错误。MCP 的 `--managed-scriptcat-data-root` 为 `~/.local/share/scriptcat-mcp`，保存 activation journal 与当前 managed ScriptCat 树。MCP 运行时直接使用 provider 的外部 executable，不协商协议，也不校验浏览器 hash、commit、版本、release root 或路径。更新 provider 保留 MCP 安装和 profile；更新 MCP 保留 provider 安装。
- **扩展状态与授权**：MCP 将固定 profile 与 managed ScriptCat 扩展作为持久安装。首次启动只以预期扩展 ID 和 `userScripts` 授权完成一次加载，并发出一次 `install_complete`；已恢复的 profile 启动不重新加载扩展。运行中的 `userScriptsAccessEnabled` 为 `false` 时才调用 `setUserScriptsAccess` 修复授权；`true` 无额外操作，`null` 表示当前无法查询。`scriptcat_status` 返回扩展 ID、版本、启用状态、`userScriptsAccessEnabled`、worker 就绪状态，以及 `startupAction`、`installCount` 和 `accessRepairCount` 诊断字段。对固定 managed extension，`set_extension_user_scripts_access` 只接受 `enabled=true`，重复调用保持幂等；传入 `enabled=false`，或通过通用 `install_extension`、`reload_extension`、`uninstall_extension` 改变该扩展，均返回 `MANAGED_EXTENSION_PROTECTED`，且不会执行底层操作。扩展目录、profile 和权限状态由 MCP 与便携制品管理，不通过浏览器 UI、`chrome://extensions/`、X11、`--load-extension`、`developerPrivate` 或 Preferences 文件管理。
- **Profile 独占**：MCP 为固定 profile 持有锁。同一时间只允许一个 owner；第二个 owner 返回 `PROFILE_BUSY`。涉及脚本写入或页面验收的任务必须等待前一个 owner 结束。
- **MCP 脚本管理与验收**：先运行 `scriptcat_status`，再以 `scriptcat_upsert_script` 写入仓库内规范化的目标 `*.user.js` 路径；按需使用 `scriptcat_list_scripts`、`scriptcat_get_script`、`scriptcat_set_enabled` 和 `scriptcat_delete_script`。随后打开真实 `@match` 页面，确认注入、UI、控制台、网络请求和核心交互。静态 DOM、普通浏览器打开页面或仅执行 lint/build 不构成运行验收。
- **用户正常浏览器安装**：用户日常浏览器使用 ScriptCat 的默认 VSCode sync 端口 `8642`。需要把当前仓库脚本推送到用户正常浏览器时，使用 `pnpm install:scriptcat -- <script.user.js>`；不传脚本时默认安装 `greenmangaming-bundle-claim.user.js`。该安装路径用于用户浏览器，不替代专用 MCP 的可复现调试验收。
- **故障处理**：`PROFILE_BUSY`、`BROWSER_UNSUPPORTED`、`EXTENSION_NOT_READY`、`INVALID_USERSCRIPT`、`SCRIPT_NOT_FOUND`、`MANAGED_EXTENSION_PROTECTED` 与 `TIMEOUT` 是 MCP 的可处理状态。遇到 `MANAGED_EXTENSION_PROTECTED` 时保留 managed extension，不重试被拒绝的通用变更；需要恢复授权时，对固定扩展调用 `set_extension_user_scripts_access` 并传入 `enabled=true`，再运行 `scriptcat_status`。provider 不可用时修复 provider 制品；扩展缺失、版本不符或 worker 未就绪时修复 MCP 制品，然后重新启动 MCP；不得改用普通 `chrome-devtools` MCP 作为 ScriptCat 验收替代。

## 浏览器 provider 与 MCP 的发布

- **provider 运行时来源**：完整 Chromium 的源码 checkout、补丁应用、编译和协议测试属于仓库外的 producer。`scripts/remote/provider/` 不包含 Chromium 源码 checkout，也不执行 `gclient`、`gn`、`ninja` 或 `autoninja`；它导入 producer 提供的预构建 runtime 候选，按 `browser/provider-contract.json` 的可执行文件与能力要求校验，并以内容地址创建可发布组件。
- **构建门禁**：本机与裸 SSH 均不得执行 `gclient`、`gn`、`autoninja`、`ninja` 或其他 Chromium 构建命令；`.codex/config.toml` 的 `PreToolUse` hook 强制该规则。只读检查不属于构建。
- **provider 三阶段**：依次执行 `scripts/remote/provider/import_runtime.py --candidate <runtime-candidate> --contract browser/provider-contract.json`、`scripts/remote/provider/package.py --component-id <component-id> --contract browser/provider-contract.json --output <archive>`、`scripts/remote/provider/install.py <archive> --contract browser/provider-contract.json --build-id <release-id> --archive-sha256 <digest>`。import 仅接受满足 contract 的候选并输出组件 ID；package 仅校验已导入组件并生成归档；install 校验归档和 contract 后原子激活到 `~/.local/share/scriptcat-browser/releases/<release-id>`，维护 `current`/`previous`。
- **MCP 三阶段**：MCP 使用 `browser/mcp.lock.json`，依次执行 `scripts/remote/mcp/build.py`、`scripts/remote/mcp/package.py --build-id <component-build-id>`、`scripts/remote/mcp/install.py <archive> --lock browser/mcp.lock.json --build-id <release-build-id> --archive-sha256 <digest>`。MCP build、lock、manifest、build 目录和归档均不读取、执行或包含 browser/provider 身份；浏览器集成只在两个产品独立安装后验收。install 原子激活到 `~/.local/share/scriptcat-mcp/releases/<release-build-id>`，维护 `current`/`previous` 并部署 managed ScriptCat，同时保持既有 profile 数据。
- **阶段边界**：每个 build、package、install 命令只完成所属阶段；package 不推送、同步、编译、测试或激活，install 不读取 Git、不访问远端或网络。归档 SHA-256 与来源校验属于各自产品的供应链完整性，MCP 运行时不以它们作为浏览器启动门禁。
- **迁移入口**：顶层 `scripts/remote/doctor.py`、`build.py`、`package.py`、`install.py` 与 `build_install.py` 只返回迁移错误；调用方选择 provider 或 MCP 后执行该产品的显式三阶段命令。
- **验收范围**：provider build 覆盖补丁与 Chromium protocol tests；MCP build 只覆盖 MCP 与 managed ScriptCat。两者的 package 分别校验自身 runtime 与归档。两个产品独立 install 后，再通过完整 MCP 验收外部浏览器调用、ScriptCat CRUD、真实注入、并发锁和进程清理。仅在共享改动或明确要求时扩大测试范围。

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
| `scripts/build-userscripts.mjs` | 将 `src/userscripts/*.user.js` bundle 到仓库根同名文件 |
| `scripts/remote/provider/` | browser provider 的 import、package、install 三阶段入口 |
| `scripts/remote/mcp/` | ScriptCat MCP 的 build、package、install 三阶段入口 |
| `scripts/remote/{doctor,build,package,install,build_install}.py` | 只返回迁移错误的旧顶层 CLI |
| `browser/provider-contract.json` | browser provider runtime 的可执行文件与能力契约 |
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

# browser provider 发布：fish 中显式按阶段执行
set provider_component_build_id (uv run --project scripts --python 3.12 python scripts/remote/provider/import_runtime.py --candidate /root/scriptcat-browser-incoming/<name> --contract browser/provider-contract.json)
set provider_archive /tmp/scriptcat-browser-portable.tar.zst
set provider_release_build_id (uv run --project scripts --python 3.12 python scripts/remote/provider/package.py --component-id $provider_component_build_id --contract browser/provider-contract.json --output $provider_archive)
set provider_archive_sha256 (string trim < "$provider_archive.sha256")
uv run --project scripts --python 3.12 python scripts/remote/provider/install.py $provider_archive --contract browser/provider-contract.json --build-id $provider_release_build_id --archive-sha256 $provider_archive_sha256

# ScriptCat MCP 远程发布：fish 中显式按阶段执行
set mcp_component_build_id (uv run --project scripts --python 3.12 python scripts/remote/mcp/build.py)
set mcp_archive /tmp/scriptcat-mcp-portable.tar.zst
set mcp_release_build_id (uv run --project scripts --python 3.12 python scripts/remote/mcp/package.py --build-id $mcp_component_build_id --output $mcp_archive)
set mcp_archive_sha256 (string trim < "$mcp_archive.sha256")
uv run --project scripts --python 3.12 python scripts/remote/mcp/install.py $mcp_archive --lock browser/mcp.lock.json --build-id $mcp_release_build_id --archive-sha256 $mcp_archive_sha256
```

## 参考

[Tampermonkey 技能](.agents/skills/tampermonkey/SKILL.md) | [site-notes](docs/site-notes.md) | [troubleshooting](docs/troubleshooting.md) | [scriptcat-require](docs/scriptcat-require.md)
