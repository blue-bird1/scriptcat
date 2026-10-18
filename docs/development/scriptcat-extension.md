# Managed ScriptCat 扩展

## 源码与发布

`browser/scriptcat` 跟随官方扩展，并增加只读消息接口 `serviceWorker/script/getSource`。MCP 通过脚本 UUID 读取保存的原始源码。

```fish
uv run --project scripts --python 3.12 python scripts/scriptcat/publish.py
```

发布要求根仓库位于干净的 `main`，子模块无未提交改动且与根仓库记录一致。publisher 在本机构建、测试，并原子替换 `~/.local/share/scriptcat-extension/managed` 的完整内容。扩展 ID 为 `mihocogjodhedlmnebhfkiahldphcimj`。

扩展不进入 MCP 的 build、package、install；两个产品分别发布。

## 加载与权限

每个 browser lifecycle 的初始化顺序：

1. 通过 Chrome 官方扩展设置界面开启开发者模式。
2. 用 `Extensions.loadUnpacked` 加载或刷新 managed 目录，并核对扩展 ID。
3. 通过官方设置界面检查并授予 userScripts 权限。
4. 权限发生变化时，再次加载该目录，刷新 worker 的 API 可用状态。
5. 完成 service worker 与 backend 就绪探测。

加载按目录内容执行，不以扩展版本或“已注册”状态跳过。`scriptcat_status` 只观察结果，不承担授权或重新加载。已运行浏览器中的内容刷新发生在下一个 lifecycle。

## 修复损坏的 managed 目录

目录缺失、内容损坏或 manifest 无效时，重新运行 publisher。结束活跃 MCP sessions 后，在明确维护中使用以下命令停止旧 lifecycle，再由新客户端启动并检查状态：

```fish
uv run --project scripts --python 3.12 python scripts/mcp/control.py stop
```
