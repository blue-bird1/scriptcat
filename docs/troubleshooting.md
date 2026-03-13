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

**可能原因**：CSP 限制、CDN 不可达、@require URL 与仓库不匹配。

**排查步骤**：

1. 检查浏览器控制台是否有 CSP 或 404 错误。
2. 若使用自托管仓库，确认 `@require` 中的 URL 指向正确（本仓库：`https://raw.githubusercontent.com/blue-bird1/scriptcat/main/vendor/page-agent.js`）。
3. 若使用自建 baseURL，需在脚本头添加对应 `@connect` 域名，否则 GM_xmlhttpRequest 会失败。

### 现象：LLM 请求失败（401/403/跨域）

**可能原因**：API Key 错误、baseURL 未在 @connect 中声明。

**排查步骤**：通过菜单「配置 Page Agent」检查 baseURL、apiKey；确认 baseURL 的域名已在 `@connect` 中列出。

---

## 待积累

<!-- Agent 修复 bug 后，按上述模板补充条目 -->
