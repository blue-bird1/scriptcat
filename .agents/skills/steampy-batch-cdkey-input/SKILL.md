---
name: steampy-batch-cdkey-input
description: Validate, repair, and enrich pasted SteamPy batch CDKey CSV. Use when the user pastes game-name/key lines and asks to check the format, add Steam AppIDs, complete missing columns, distinguish AppID from SteamPy gameId, or prepare input for the SteamPy seller batch tool.
---

# SteamPy 批量 CDKey 输入

把复制的游戏名与 CDKey 整理成可预检的 CSV；只处理文本和查询元数据，不激活 Key、不调用上架接口。

## 输入契约

- 每行固定为 `gameName,key[,appId[,gameId]]`，共 2–4 列。
- `key` 必填；不接受单列 Key。
- `gameName`、`appId`、`gameId` 至少提供一个。
- `appId` 是 Steam 商店 AppID；`gameId` 是 SteamPy 商品 ID，二者不可混用。
- ID 必须保持为十进制正整数字符串，不转换为 JavaScript Number。
- 游戏名含逗号或双引号时使用标准 CSV 双引号规则。
- 保持原始行序与 Key 原文；受控本地输出不得遮盖或改写 Key。

## 处理流程

1. 逐行按标准 CSV 解析，检查列数、空 Key、重复 Key、非法 ID 和错位列。
2. 根据用户要求补列；未特别说明时，优先把已核实的 AppID 补到第三列，不强求第四列 gameId。
3. 缺少 AppID 时查询并核对 Steam 官方商店页面或官方搜索结果；区分本体、DLC、原声带、试玩版和同名游戏。
4. 只有唯一匹配时填写 AppID。存在同名、版本或商店下架歧义时不得猜测，保留空列并指出对应行。
5. 用户要求 gameId 时，通过当前 SteamPy 卖家区域的商品解析结果核实；不得把 AppID 复制成 gameId。
6. 同时存在 appId 与 gameId 时，检查二者是否解析到同一商品；冲突时报告而不自动覆盖。
7. 输出整理后的完整 CSV，并在其后简短列出仍有歧义或无法核实的行。

## 输出示例

输入：

```csv
Example Game,AAAAA-BBBBB-CCCCC
"Example, Deluxe",DDDDD-EEEEE-FFFFF
```

补充 AppID 后：

```csv
Example Game,AAAAA-BBBBB-CCCCC,123456
"Example, Deluxe",DDDDD-EEEEE-FFFFF,234567
```

不要把示例 ID 当作真实查询结果。
