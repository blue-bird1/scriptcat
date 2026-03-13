# 常见问题排查

随 bug 修复积累，记录「现象 → 可能原因 → 排查步骤」。**每次修复 bug 后，若为可复现的典型问题，主动补充**。

## 模板

```markdown
### 现象描述

（用户报告的现象）

### 可能原因

1. ...
2. ...

### 排查步骤

1. ...
2. ...

### 相关脚本

- xxx.user.js
```

---

## Page Agent

### 现象：@require 的 vendor/page-agent.js 加载失败

**可能原因**：CSP 限制、CDN 不可达、@require URL 与仓库不匹配、**Scriptcat 未声明 @connect**。

**排查步骤**：

1. 检查浏览器控制台是否有 CSP 或 404 错误。
2. **Scriptcat 要求**：@require 到 `raw.githubusercontent.com` 时，必须在脚本头声明 `@connect raw.githubusercontent.com`，否则加载会静默失败。
3. 若使用自托管仓库，确认 `@require` 中的 URL 指向正确（本仓库：`https://raw.githubusercontent.com/blue-bird1/scriptcat/main/vendor/page-agent.js`）。
4. 若使用自建 baseURL，需在脚本头添加对应 `@connect` 域名，否则 GM_xmlhttpRequest 会失败。

### 现象：window.PageAgent 未加载，请检查 @require

**可能原因**：

1. **@require 加载失败**：404（vendor 未 push）、网络不可达、SRI 校验失败。
2. **构建产物导出格式**：参考 [scriptcat.org lib](https://github.com/scriptscat/lib)（如 ajaxHooker、ElementGetter），使用顶层 `var X = ...` 创建全局，主脚本直接使用 `X` 而非 `window.X`。本仓库的 IIFE 输出 `var PageAgent = exports`，构造函数在 `PageAgent.PageAgent`，userscript 已兼容。
3. **全局挂载**：若主脚本中 `PageAgent` 仍为 undefined，build 已在 vendor 末尾追加显式挂载到 `globalThis`/`window`/`self`，需重新执行 `./scripts/build-page-agent.sh` 并 push 新 vendor。

**排查步骤**：

1. 在浏览器控制台查看是否有 404、CSP、SRI 错误。
2. 直接访问 @require URL，确认返回 200 且内容正确。
3. 检查 `vendor/page-agent.js` 首行是否包含 `var PageAgent=`；若无，需在 `page-agent-userscript-entry.ts` 添加 `export { PageAgent }` 并重新构建。
4. 确认构建时未跳过 prepare（`npm install` 会触发），且 `./scripts/build-page-agent.sh` 完整执行。

### 现象：LLM 请求失败（401/403/跨域）

**可能原因**：API Key 错误、baseURL 未在 @connect 中声明。

**排查步骤**：通过菜单「配置 Page Agent」检查 baseURL、apiKey；确认 baseURL 的域名已在 `@connect` 中列出。

---

## 待积累

<!-- Agent 修复 bug 后，按上述模板补充条目 -->
