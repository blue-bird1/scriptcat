# ScriptCat MCP 本地发布

## 构建与归档

`browser/mcp.lock.json` 固定 `browser/chrome-devtools-mcp` 的源码提交。浏览器路径取自 `.codex/config.toml` 的 `--executable-path`；本仓库不编译或发布 Chromium。

本地流水线依次执行 build、package、install。build 在子模块内以 `PUPPETEER_SKIP_DOWNLOAD=true` 安装依赖、编译并生成候选 runtime，使用临时 profile 对实际候选制品运行共享浏览器 E2E。已验证 component 保存在 `~/.local/share/scriptcat-mcp-build`。package 由该 component 生成 schema 5 归档。

```fish
set component_id (uv run --project scripts --python 3.12 python scripts/mcp/build.py)
set archive /tmp/scriptcat-mcp-portable.tar.zst
set release_id (uv run --project scripts --python 3.12 python scripts/mcp/package.py --build-id $component_id --output $archive)
set archive_sha256 (string trim < "$archive.sha256")
uv run --project scripts --python 3.12 python scripts/mcp/install.py $archive --lock browser/mcp.lock.json --build-id $release_id --archive-sha256 $archive_sha256
```

安装结果位于 `~/.local/share/scriptcat-mcp`。客户端始终使用 `current/mcp/bin/chrome-devtools-mcp.js`。

## 安装交接

install 先验证归档摘要、lock、来源记录和完整 runtime 清单，再物化新 release。旧 runtime 准备排他 handoff，并继续持有 abstract socket；切换 `current`、`previous` 后，安装器请求旧 broker commit。

- commit 前失败：abort handoff，恢复原链接。
- broker commit 成功：新 release 已激活；后续 journal 清理失败不回滚链接。
- broker 不存在或旧 runtime 尚无 shared 模式：继续安装。
- 存在活跃客户端、运行中的 shared runtime 不支持 handoff，或交接控制出错：切换前中止。

首次升级不支持 handoff 的 shared runtime 时，先结束活跃 sessions，在明确维护中运行 `scripts/mcp/control.py stop`，再重试 install。安装器不自动回退到 stop。

MCP 发布不替换 managed 扩展，也不修改固定 profile 中的脚本与 GM 数据。
