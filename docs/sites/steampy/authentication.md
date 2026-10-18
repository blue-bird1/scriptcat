# SteamPy 请求鉴权

## 令牌来源

SteamPy 登录令牌保存在站点的 `localStorage.accessToken`。SteamPy Plus 直接读取该值。

Keylol 价格脚本和 Sonkwo 价格脚本分别在 SteamPy 页面执行令牌同步，再从各自的 GM 存储读取 `accessToken`。GM 存储默认按脚本 UUID 隔离；这两个脚本没有声明共享 `storagename`，彼此不传递令牌。

同步实现位于 `src/lib/steampy/access-token.js`。

## XBoot 响应

`src/lib/steampy/xboot-client.js` 使用 `accesstoken` 请求头传递令牌，并保留站点的 `app_token` 请求头。当前 `app_token` 值为空字符串。

HTTP 成功后，响应仍须满足 `success` 为真且 `code === 200`，业务数据取自 `result`。

以下响应使客户端停止剩余请求：

- HTTP 302 的最终地址为 `/xboot/common/needLogin`。
- 业务响应的 `code` 为 401，或 `message` 包含 `token`。

重新登录 SteamPy 后刷新脚本所在页面，才能建立新的客户端状态。
