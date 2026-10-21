# ScriptCat 浏览器验收

## 环境

`chrome-devtools-scriptcat` 使用已安装的 `/usr/bin/google-chrome`，通过 CDP pipe 启动独立 headless 浏览器。

- runtime：`~/.local/share/scriptcat-mcp/current/mcp/bin/chrome-devtools-mcp.js`。
- 固定 profile：`~/.local/share/scriptcat-mcp/chromium-profile`，保存脚本、GM 存储和登录态。
- managed 扩展：`~/.local/share/scriptcat-extension/managed`。
- 代理：`http://127.0.0.1:7891`，用于页面流量及 MCP 的 HTTP/HTTPS 请求。

Pi 读取 `.mcp.json`，Codex 读取 `.codex/config.toml`，Cursor 读取 `.cursor/mcp.json`。这三个文件属于本机配置，含各自的绝对路径，已被 `.gitignore` 忽略且不纳入版本库，需在检出目录自行创建。配置中的 `--workspace` 授予仓库文件访问权限，文件操作仍接受 filesystem roots 校验。

## 会话与脚本

每个 MCP session 首先调用 `scriptcat_status`。可用状态包括扩展启用、`userScriptsAccessEnabled: true`、service worker 与 backend transport 就绪。

以 `scriptcat_upsert_script` 写入仓库内规范化的目标脚本路径。工具关闭该脚本的后台更新检查，防止外部 `@updateURL` 覆盖仓库源码。`scriptcat_get_script` 返回 ScriptCat 保存的原始源码。

打开真实 `@match` 页面，核对注入、UI、控制台、请求和核心交互。写入类操作通过独立读取服务端结果验证，不以成功提示代替持久化结果。

## 共享进程

持久 broker 独占浏览器和固定 profile。每个客户端通过 stdio proxy 建立独立 MCP session 与 `McpContext`；关闭客户端不会结束浏览器，也不会刷新扩展。

```fish
uv run --project scripts --python 3.12 python scripts/mcp/control.py status
```

`control.py` 从本机的 `.codex/config.toml` 复用启动参数。`stop` 拒绝仍有活跃客户端的停机请求，只用于明确维护或系统退出，不用于调试清理或正常发布。
