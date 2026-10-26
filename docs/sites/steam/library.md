# Steam 库数据

## 动态商店

登录态下请求 `GET https://store.steampowered.com/dynamicstore/userdata/`，读取以下字段：

| 字段 | 含义与响应形态 |
| --- | --- |
| `rgOwnedApps` | 自有游戏 AppID 数组 |
| `rgWishlist` | 愿望单 AppID 数组 |
| `rgOwnedPackages` | 不透明的 PackageID 列表，按原值保存，不套用 AppID 正整数校验 |
| `rgIgnoredApps` | 现代登录响应以 AppID 字符串为键的对象；匿名或旧响应可能为空数组 |

SteamPy Plus 将 `rgIgnoredApps` 对象的键转换为 ignored AppID 集合。

## 家庭库

家庭库同步先从 `GET https://store.steampowered.com/pointssummary/ajaxgetasyncconfig` 的 `data.webapi_token` 取得令牌，再请求 `IFamilyGroupsService/GetSharedLibraryApps/v1/`。

请求使用 `family_groupid=0`，并包含已排除、免费、非游戏及自有项目。响应中，`exclude_reason === 0` 且 `owner_steamids` 不含 `owner_steamid` 的项目计入可借用家庭库。

实现位于 `src/lib/steampy/steam-library.js`。

## 列表中的已拥有游戏

自有库中的 AppID 视为已拥有；开启「家庭库游戏视为已拥有」后，可借用家庭库 AppID 同样视为已拥有。CDKey 列表筛选栏的「隐藏已拥有」默认勾选，已拥有游戏不进入列表。取消勾选后，这些游戏与未拥有游戏一样，仍接受价格、DLC 和已忽略过滤。ScriptCat 菜单「已拥有游戏」切换同一设置。状态保存在 `steamPriceFilterState` 的 `hideOwned`，缺省为 `true`。
