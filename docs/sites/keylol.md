# Keylol 登录状态与价格入口

## 签到状态

`keylolsign.user.js` 请求 `GET https://keylol.com`，不另发签到 API 请求。登录判断依赖 `#nav-user-action-bar ul.list-inline` 内的登录、注册链接。

首页 HTML 中的 `showDialog("你已获得今天的体力和蒸汽奖励", ...)` 表示本次获取到签到成功提示；脚本在已登录且没有该提示时报告“今日已签到”。这是脚本的状态判定方式，不是独立的签到查询接口。

## 帖子价格入口

价格脚本在首帖引用块 `#postlist > [id^="post_"]:first-of-type .quote blockquote` 内提取 Steam App 链接，排除 `.showhide`、`.sff_collapse` 隐藏内容。目标链接还需邻接 `barter.vg`、`104.236.232.190` 链接，或“无进包记录”标记。

价格链接指向 `/cdkDetail?name=cn&gameId=<steamGame.id>`，不预请求详情接口。

SteamPy 查询与价格展示实现位于 `src/lib/keylol/steampy-price.js`，使用 `src/lib/steampy/xboot-client.js` 的共享请求实现。
