# SteamPy 收藏（心愿单）接口

App 的收藏列表由 `appUserDetail` 控制器提供，Web 端没有对应页面。接口与 Web 使用同一套 XBoot 鉴权，`localStorage.accessToken` 可直接读取。

## 列表

```
GET https://steampy.com/xboot/appUserDetail/wishGame
GET https://steampy.com/xboot/appUserDetail/pywishGame
```

两个接口返回同结构的 Spring 分页对象，语义不同：

| 接口 | 含义 |
| --- | --- |
| `wishGame` | Steam 愿望单 |
| `pywishGame` | SteamPy 收藏夹 |

同一账号实测分别返回 57 条与 19 条，`pywishGame` 的条目额外带 `arsMkPrice`、`endDisc`。两条列表有交叉，同一 AppID 可同时出现在两边。

请求头：

```
accesstoken: <localStorage.accessToken>
app_token: ""
```

`app_token` 当前为空字符串。缺失 `accesstoken` 时 HTTP 200，业务 `code=401`、`message=您还未登录`。

参数：

| 参数 | 说明 |
| --- | --- |
| `pageNumber` | 从 1 开始；缺省为 1 |
| `pageSize` | 缺省 10；上限 100，传 200 时 `size` 仍为 100 |
| `sort` | 实测 `createTime`、`updateTime` 生效 |
| `order` | `asc` / `desc` |

响应：

```
result.totalElements  总条数
result.totalPages     总页数
result.size           本次页大小
result.number         当前页，从 0 开始
result.content[]      条目
```

条目字段：

| 字段 | 含义 |
| --- | --- |
| `appId` | Steam AppID |
| `gameName` | 游戏名 |
| `gameAva` | 头图 URL |
| `oriPrice` | Steam 原价 |
| `miniPrice` | 最低 key 价 |
| `arsMkPrice` | 阿根廷区参考价，仅 `pywishGame` 出现 |
| `endDisc` | 折扣结束时间，仅 `pywishGame` 出现 |
| `rating` | 评分 |
| `hisFlag` | 史低标记 |
| `promoFlag` | 促销标记 |

## 单条状态

```
GET https://steampy.com/xboot/appUserDetail/wishOne?appId=1735700
```

`result` 为字符串 `"1"` 表示在收藏中。参数名必须是 `appId`，传 `gameId` 返回 `code=500` 缺少参数。

## 增删

```
POST https://steampy.com/xboot/appUserDetail/wishAdd
POST https://steampy.com/xboot/appUserDetail/wishRemove
POST https://steampy.com/xboot/appUserDetail/wishPush
```

三者均为 POST。空 JSON 请求体返回 `code=500` 缺少必须输入参数，说明路由存在但参数未探明；本次未提交真实参数，避免改动账号数据。

## 调用示例

```sh
curl -sS 'https://steampy.com/xboot/appUserDetail/wishGame?pageNumber=1&pageSize=100' \
  -H "accesstoken: $STEAMPY_ACCESS_TOKEN" \
  -H 'app_token: ' \
  | jq '.result.content[] | {appId, gameName, miniPrice}'
```

令牌来源与失效处理见 `authentication.md`。

## 验证记录

- 2026-10-27，App 3.1.1（`com.steampy.app`），Web 端 `accessToken`。
- `wishGame`：57 条，`pageSize=100` 一次取回；`pageNumber=2&pageSize=5` 返回第 6–10 条。
- `pywishGame`：19 条。
- 两者语义（Steam 愿望单 / SteamPy 收藏夹）由用户于 2026-10-27 确认。
- 无令牌返回 `code=401`。
- App 3.2.0 与 3.1.1 签名证书一致（SHA-256 `44f45f32678ae9a31aa3e95a667727374dbbcedaeaea91857db4488d0e9395d6`）。
