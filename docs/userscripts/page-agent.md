# Page Agent 的构建与请求适配

## Vendor 构建

Page Agent 来源为 https://github.com/alibaba/page-agent 。仓库使用独立入口 `scripts/page-agent-userscript-entry.ts` 导出构造函数，不启动上游 demo；实例由 `page-agent.user.js` 创建。

`./scripts/build-page-agent.sh` 固定上游版本 `1.5.6`，在 `.build/page-agent` 构建并将产物写入 `vendor/page-agent.js`。此流程独立于根项目的 `pnpm build`，后者只处理 `src/userscripts/`。

构建脚本需要 Node.js 20+、Git 和上游使用的 npm 工具链。它会替换上游 demo 入口、执行上游库构建，并在复制产物后追加全局挂载代码。

## 构造函数入口

现存 vendor 使用顶层 `PageAgent` exports 对象，构造函数位于 `PageAgent.PageAgent`。主脚本的 `initAgent` 也接受 `PageAgent` 本身为构造函数的形式。

诊断加载问题时，分别核对资源是否加载、导出对象的形态，以及主脚本使用的标识符作用域；不要仅凭 `window.PageAgent` 是否存在判断加载结果。

## LLM 请求适配

`page-agent.user.js` 将 `gmFetch` 作为 `customFetch` 传给 Page Agent，使用 `GM_xmlhttpRequest` 发出模型请求。

该适配器接受 method、headers、body、signal，返回含 `ok`、`status`、`statusText`、`headers`、`json()`、`text()` 的响应外观，不是完整的原生 `Response`。AbortSignal 会使请求 Promise 拒绝；当前实现没有通过 GM 请求句柄取消底层传输。

根脚本仍内置 `gmFetch`，没有导入 `src/lib/page-agent/gm-fetch.js`。更换模型服务时，需要同步核对目标域名的 GM 网络请求权限。
