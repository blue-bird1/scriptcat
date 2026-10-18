# ScriptCat 外部资源与网络权限

## 资源下载

`@require` 由扩展资源服务下载并缓存。当前实现直接调用 `fetch(url)`，不使用脚本的 `@connect` 白名单。不能将 `@connect` 写成外域 `@require` 的加载前提。

实现：`browser/scriptcat/src/app/service/service_worker/resource.ts`。

## 用户脚本网络请求

`GM_xmlhttpRequest` 的网络权限通过 `@connect` 检查。用户脚本向哪些站点发起 GM 请求，就声明相应域名；依赖文件的下载域名与运行时 API 域名分别判断。

实现：`browser/scriptcat/src/app/service/service_worker/gm_api/gm_api.ts`。

## 作用域与导出

编译器将 require 代码放在主脚本的 async 包装之外。库的顶层声明可被主脚本通过标识符访问，但不等同于总能从页面的 `window` 读取。库实际导出的对象或构造函数由该库决定。

实现：`browser/scriptcat/src/app/service/content/utils.ts` 的 `compileScriptCodeByResource`。

不要为假设中的库格式添加兼容分支；集成时核对正在使用的构建产物。官方 metadata 说明：https://docs.scriptcat.org/docs/dev/meta 。
