# scriptcat

本仓库维护运行于 ScriptCat 的用户脚本。维护者也是使用者；接口、鉴权和选择器以真实站点行为为依据，交付包含可用的交互与可理解的错误反馈。

## 源码与提交

- 修改脚本前读取 metadata。仓库身份与发布 URL 使用真实项目信息。
- 有 `src/userscripts/` 入口的脚本只修改源码及 `src/lib/`，通过 `pnpm build` 生成根目录同名产物；没有入口的根目录脚本直接维护。
- 通用能力放在 `src/lib/userscript/`，站点能力放在对应站点目录，入口保持简短。
- 在 `main` 直接开发，不走 PR。每个可验收单元提交源码与对应产物。

## 浏览器验收与安装

- 本仓库用户脚本使用 `chrome-devtools-scriptcat` 和 `scriptcat-script-setup` 技能验收。打开真实 `@match` 页面检查注入、UI、控制台、网络请求及核心交互；静态 DOM 或 lint/build 不能替代运行验收。
- 每个新 MCP session 首先调用 `scriptcat_status`，确认扩展启用、`userScriptsAccessEnabled: true`、service worker 和 backend 就绪，再用 `scriptcat_upsert_script` 写入仓库内规范化的目标脚本路径。
- 持久 broker 独占固定 profile 与浏览器进程。不得发送进程信号、手动启动浏览器、复制 profile、删除 `Singleton*`，或用其他进程争用该 profile。关闭 proxy 或 session 不结束浏览器。
- lifecycle 初始化负责开启开发者模式、加载 managed 目录和授予 userScripts 权限。加载按目录内容执行，不按版本或已注册状态跳过；仅权限改变时再次加载以刷新 worker。`scriptcat_status` 只观察，不能用额外授权或重新加载绕过初始化失败。
- 浏览器使用已安装的官方 Google Chrome。本仓库分别发布 MCP 与 managed 扩展，不编译或发布 Chromium。
- `scripts/mcp/control.py stop` 只用于明确维护或系统退出，不用于调试清理，也不代替 MCP 发布中的排他 handoff。安装器不得在交接失败后自动 fallback stop。
- 每次修改用户脚本并完成构建、测试和提交后，对本轮每个根目录产物执行 `pnpm install:scriptcat -- <script.user.js>`。安装到日常浏览器成功才算完成；该流程独立于专用 MCP 验收。
