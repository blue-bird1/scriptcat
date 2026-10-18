# 用户脚本构建与安装

## 源码与产物

`src/userscripts/*.user.js` 是 esbuild 入口。对应的根目录同名文件是安装产物；没有源码入口的根目录脚本直接维护。

入口保留 UserScript metadata，正文使用 ES module。站点代码放在 `src/lib/<site>/`，通用代码放在 `src/lib/userscript/`。共享模块在构建时内联，不增加运行时 `@require`。

`scripts/build-userscripts.mjs` 自动收集入口，原样保留 metadata，输出可读 IIFE，不压缩、不生成 sourcemap。中间文件位于 `.build/userscripts/`。

```fish
pnpm build
pnpm build:check
pnpm run lint:userscripts -- zlib.user.js
```

`build:check` 构建全部入口并检查生成脚本。新增源码目录和可提交文件时，同步检查 `.gitignore` 白名单。

## 安装到日常浏览器

```fish
pnpm install:scriptcat -- zlib.user.js
```

安装器通过本机 VSCode sync 端口 `8642` 连接日常浏览器中的 ScriptCat。它不操作专用 MCP profile。省略文件参数时，默认安装 `greenmangaming-bundle-claim.user.js`。

实现位于 `scripts/userscripts/install-to-scriptcat.mjs` 和 `scripts/userscripts/scriptcat-vscode-sync.mjs`。
