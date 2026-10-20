# 用户脚本构建与安装

## 源码与产物

`src/userscripts/*.user.js` 是 esbuild 入口。对应的根目录同名文件是安装产物；没有源码入口的根目录脚本直接维护。

入口保留 UserScript metadata，正文使用 ES module。站点代码放在 `src/lib/<site>/`，通用代码放在 `src/lib/userscript/`。共享模块在构建时内联，不增加运行时 `@require`。

`scripts/build-userscripts.mjs` 自动收集入口，原样保留 metadata，输出可读 IIFE，不压缩、不生成 sourcemap。esbuild 在内存中返回输出，构建脚本直接写入根目录产物。

```fish
pnpm build
pnpm build --entry zlib.isbn_highlight.user.js
pnpm build --entry zlib.isbn_highlight.user.js --entry zlib.user.js
pnpm build --help
pnpm build:check
pnpm run lint:userscripts -- zlib.user.js
```

`build` 默认构建全部入口。`--entry <name.user.js>` 只构建指定入口，可重复传入；名称必须是 `src/userscripts/` 中收集到的文件名。构建脚本在写入产物前校验全部名称。`--help`（或 `-h`）显示帮助并退出。

`build:check` 构建全部入口并检查生成脚本。新增源码目录和可提交文件时，同步检查 `.gitignore` 白名单。

## 安装到日常浏览器

```fish
pnpm install:scriptcat -- zlib.user.js
```

安装器通过本机 VSCode sync 端口 `8642` 连接日常浏览器中的 ScriptCat。它不操作专用 MCP profile。省略文件参数时，默认安装 `greenmangaming-bundle-claim.user.js`。

实现位于 `scripts/userscripts/install-to-scriptcat.mjs` 和 `scripts/userscripts/scriptcat-vscode-sync.mjs`。
