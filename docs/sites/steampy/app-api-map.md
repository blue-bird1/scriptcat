# SteamPy App 接口表

从 App 3.1.1 运行时 dex 提取的 XBoot 路由，按模块归类。用于避免重复做加固包分析与运行时抓取。

来源与限制：

- 3.2.0 官方包由 360 Jiagu 加固，静态无路由字符串；在 Android 11 测试机上加固层读取 `/bin/base.apk` 失败并退出。
- 3.1.1 与 3.2.0 签名证书一致（SHA-256 `44f45f32678ae9a31aa3e95a667727374dbbcedaeaea91857db4488d0e9395d6`），可正常运行；用 `frida-dexdump` 取 25 个运行时 dex 后提取路由。
- 路由字符串只说明路径存在，参数与语义按命名并结合实测响应归纳；未逐个验证参数。
- 实测使用 Web 端 `localStorage.accessToken`，请求头 `accesstoken`，`app_token` 为空字符串。

统一约定：

- 基址 `https://steampy.com`，路径前缀 `/xboot/`。
- 响应恒为 HTTP 200，业务码在 `code`：`200` 成功、`203` 无权限或业务前置不满足、`401` 未登录、`500` 参数缺失或方法不符。
- 分页对象字段 `content`、`totalElements`、`totalPages`、`size`、`number`。

已验证可用的读取接口：

```
GET /xboot/appUserDetail/wishGame?pageNumber=1&pageSize=100   # Steam 愿望单，57 条
GET /xboot/appUserDetail/pywishGame?pageNumber=1&pageSize=100 # SteamPy 收藏夹，19 条
GET /xboot/appUserDetail/wishOne?appId=1735700                # result "1" 表示在 Steam 愿望单
GET /xboot/steamApp/recKey                                    # 10 条推荐
GET /xboot/steamApp/listUpcoming                              # 即将发售
GET /xboot/steamPublisher/getList                             # 发行商分页
GET /xboot/appCard/listSelf                                   # 我的橱柜卡
GET /xboot/hisKeyOrder/listHisSelf                            # 历史 Key 订单
GET /xboot/detLog/show                                        # 明细日志
GET /xboot/UserCertify/queryCertifyNew                        # 实名状态
```

## 模块

| 前缀 | 作用 |
| --- | --- |
| `_oauth` | App 登录入口，`pyLogin` 换取令牌。 |
| `accountBook` | 资金账本：用户流水列表与清空。 |
| `accSeller` | Steam 余额卖家：绑定账号、上架/下架余额、按额度出售。实测不带卖家身份时返回“拒绝请求”。 |
| `appCard` | 游戏橱柜卡片：交易校验、我的卡片、解锁。 |
| `applyForm` | 卖家/回收申请表单：提交、查询自己的申请、查看要求。实测提示“交易笔数未达标”。 |
| `appTxActLog` | 交易行为日志上报。 |
| `appUserDetail` | 个人资料、Steam 换绑，以及两份收藏列表：`wishGame` 为 Steam 愿望单，`pywishGame` 为 SteamPy 收藏夹；`wishOne` 查询单个 AppID 是否在愿望单，`wishAdd`/`wishRemove` 增删。 |
| `area` | 地区字典。 |
| `arsAccountOrder` | 阿根廷区账号订单：确认、取支付令牌。 |
| `blCertify` | 另一条实名认证通道（前缀 bl），已实测返回“认证信息有误”，用途与 UserCertify 重叠。 |
| `blExpAddress` | 代购收货地址（经验/等级地址）读取与编辑。 |
| `blExpOrder` | 代购经验订单：下单、支付、查询。 |
| `blOrder` | 代购订单（礼物/帮领）：购买列表、支付、详情、回收、收货。 |
| `blOrderDetail` | 代购订单明细：Key 校验/展示、重新上架。 |
| `bsSellerLog` | 卖家申请日志。 |
| `buApplyForm` | 买号/回收申请表单查看。 |
| `bunAppReply` | 社区回复：发表、点赞、他人/自己/全部列表。 |
| `bunAppReplyThird` | 社区第三方回复：发表与列表。 |
| `bunAppReview` | 社区评测：发表、编辑、点赞、收藏、他人/自己列表。 |
| `bunAppTip` | 社区提示/举报：列表与举报提交。 |
| `bundle` | 捆绑包查询：按 AppID、游戏、名称、URL 查包内容。 |
| `buOrder` | 买号订单：购买列表、支付、详情、拒付。 |
| `buOrderDetail` | 买号订单明细：Key 校验/展示、重新上架。 |
| `chest` | 宝箱（抽奖箱）：箱内游戏、单个宝箱、分页列表。 |
| `currency` | 币种与汇率。 |
| `detLog` | 订单明细日志分页。 |
| `dictData` | 字典数据维护。 |
| `gamePlayOrder` | 试玩/租号订单：购买列表、支付、设置内容。 |
| `grandOrder` | 大额/跨区代购订单：地区、待确认、待定价。 |
| `hisKeyOrder` | 历史 Key 订单：列表与条件查询（条件查询需管理权限）。 |
| `lottery` | 抽奖：详情、空奖、已完成记录。 |
| `mallOrder` | 商城订单：下单、支付、确认、买家完成、改单。 |
| `mallSku` | 商城 SKU 详情。 |
| `mallSpu` | 商城 SPU 在售信息。 |
| `marketOrder` | C2C 市场挂单：待确认、待定价、退款申请、重新支付。 |
| `payWayLimit` | 支付方式限额：协议校验与查询。 |
| `prkOrder` | 秒发卡（prk）订单：购买、支付、卡密校验、退款、查看我的卡。 |
| `prkSale` | 秒发卡在售列表。 |
| `pyAppAuditUser` | App 审核用户标记的读写。 |
| `pyAVS` | 地址校验服务凭据。 |
| `pyCommon` | 公共计算，`calTechFee` 实测 404，可能已迁移到 `techFee/calc`。 |
| `raffleTicket` | 抽奖券：中奖详情、我的券、用户券。 |
| `saOrder` | Steam 账号（sa）交易订单：买卖列表、支付、库存与交易链接。 |
| `saTempToken` | Steam 账号临时令牌：批量添加与列表。实测未绑定 Steam 时返回“未绑定Steam账号”。 |
| `shareAct` | 分享活动创建。 |
| `sharePromo` | App 分享推广参数。 |
| `skuSale` | SKU 在售详情与分页。 |
| `steamApp` | 商店目录：详情、即将发售、相似推荐、推荐 Key。实测 `recKey` 返回 10 条。 |
| `steamGame` | 国区游戏目录，`keyHotPublisher` 按发行商取热销。 |
| `steamKeyOrder` | 国区 Key 订单：条件查询（需权限）、展示 Key。 |
| `steamOrder` | 国区 Steam 订单：买家完成、退款。 |
| `steamPublisher` | 发行商列表。实测返回分页数据。 |
| `techFee` | 手续费计算。 |
| `typeTicket` | 分类券码。 |
| `upload` | 文件上传：通用、App、PY 三套入口。 |
| `user` | 用户查询与禁用（管理端）。实测条件查询返回“无权限”。 |
| `UserCertify` | 实名认证：初始化、活体检测、查询认证状态。已实测 `queryCertifyNew` 返回 `kycAli`/`kycDun`/`kycSms`。 |
| `userInter` | 用户关联/交集写入。 |
| `userMission` | 用户任务：领取、参与、任务详情。 |
| `userReqLog` | 请求日志查询（管理端）。 |
| `userTicket` | 客服工单：我的工单、提交。 |
| `userTicketDetail` | 工单详情与回复。 |
| `usKeyOrder` | 美区 Key 订单：购买、支付、卡密校验。 |
| `usKeySale` | 美区 Key 在售列表。 |
| `usSteamGame` | 美区按 AppID 查人民币 Key 价。 |

## 路由清单

### _oauth

```
/xboot/_oauth/pyLogin
```

### accountBook

```
/xboot/accountBook/userDelAll/{ids}
/xboot/accountBook/userList
```

### accSeller

```
/xboot/accSeller/apv
/xboot/accSeller/bind
/xboot/accSeller/bindSaleAmt
/xboot/accSeller/list
/xboot/accSeller/offSell
/xboot/accSeller/show
/xboot/accSeller/startSell
/xboot/accSeller/unbind
```

### appCard

```
/xboot/appCard/checkTx
/xboot/appCard/listSelf
/xboot/appCard/unlock
```

### applyForm

```
/xboot/applyForm/add
/xboot/applyForm/getSelf
/xboot/applyForm/show
```

### appTxActLog

```
/xboot/appTxActLog/add
```

### appUserDetail

```
/xboot/appUserDetail/alterSteam
/xboot/appUserDetail/palWish
/xboot/appUserDetail/pywishGame
/xboot/appUserDetail/pywishRemove
/xboot/appUserDetail/wishAdd
/xboot/appUserDetail/wishGame
/xboot/appUserDetail/wishOne
/xboot/appUserDetail/wishPush
/xboot/appUserDetail/wishRemove
```

### area

```
/xboot/area/getArea
```

### arsAccountOrder

```
/xboot/arsAccountOrder/confirm
/xboot/arsAccountOrder/getToken
```

### blCertify

```
/xboot/blCertify/initialize
/xboot/blCertify/queryCertify
```

### blExpAddress

```
/xboot/blExpAddress/edit
/xboot/blExpAddress/getSelf
```

### blExpOrder

```
/xboot/blExpOrder/addExp
/xboot/blExpOrder/buyList
/xboot/blExpOrder/checkPay
/xboot/blExpOrder/getOne
/xboot/blExpOrder/payOrder
```

### blOrder

```
/xboot/blOrder/buyList
/xboot/blOrder/checkPay
/xboot/blOrder/detOne
/xboot/blOrder/detPage
/xboot/blOrder/getOne
/xboot/blOrder/payOrder
/xboot/blOrder/recPrice
/xboot/blOrder/recycle
/xboot/blOrder/takeDeliver
```

### blOrderDetail

```
/xboot/blOrderDetail/keyCheckV2
/xboot/blOrderDetail/keyFirstV2
/xboot/blOrderDetail/keyLog
/xboot/blOrderDetail/keyTokenV2
/xboot/blOrderDetail/resell
/xboot/blOrderDetail/resellOff
/xboot/blOrderDetail/showKey
```

### bsSellerLog

```
/xboot/bsSellerLog/applyForBs
```

### buApplyForm

```
/xboot/buApplyForm/show
```

### bunAppReply

```
/xboot/bunAppReply/addReply
/xboot/bunAppReply/liked
/xboot/bunAppReply/otherPage
/xboot/bunAppReply/selfPage
/xboot/bunAppReply/showPage
```

### bunAppReplyThird

```
/xboot/bunAppReplyThird/addThird
/xboot/bunAppReplyThird/showPage
```

### bunAppReview

```
/xboot/bunAppReview/addReview
/xboot/bunAppReview/editReview
/xboot/bunAppReview/funned
/xboot/bunAppReview/liked
/xboot/bunAppReview/otherOne
/xboot/bunAppReview/otherPage
/xboot/bunAppReview/selfPage
/xboot/bunAppReview/selfReview
/xboot/bunAppReview/showPage
```

### bunAppTip

```
/xboot/bunAppTip/showPage
/xboot/bunAppTip/tipOff
```

### bundle

```
/xboot/bundle/showAppId
/xboot/bundle/showGame
/xboot/bundle/showName
/xboot/bundle/showOne
/xboot/bundle/showPage
/xboot/bundle/showUrl
```

### buOrder

```
/xboot/buOrder/buyList
/xboot/buOrder/checkPay
/xboot/buOrder/detOne
/xboot/buOrder/detPage
/xboot/buOrder/payOrder
/xboot/buOrder/rejectPay
```

### buOrderDetail

```
/xboot/buOrderDetail/keyCheckV2
/xboot/buOrderDetail/keyFirstV2
/xboot/buOrderDetail/keyLog
/xboot/buOrderDetail/keyTokenV2
/xboot/buOrderDetail/resell
/xboot/buOrderDetail/resellOff
/xboot/buOrderDetail/showKey
```

### chest

```
/xboot/chest/showGame
/xboot/chest/showOne
/xboot/chest/showPageV2
```

### currency

```
/xboot/currency/getOne
```

### detLog

```
/xboot/detLog/show
```

### dictData

```
/xboot/dictData/edit
```

### gamePlayOrder

```
/xboot/gamePlayOrder/buyList
/xboot/gamePlayOrder/payOrder
/xboot/gamePlayOrder/setContent
```

### grandOrder

```
/xboot/grandOrder/getArea
/xboot/grandOrder/pendingCheck
/xboot/grandOrder/pendingPrice
```

### hisKeyOrder

```
/xboot/hisKeyOrder/buyList
/xboot/hisKeyOrder/getByCondition
/xboot/hisKeyOrder/listHisSelf
```

### lottery

```
/xboot/lottery/det
/xboot/lottery/ltAir
/xboot/lottery/ltDone
```

### mallOrder

```
/xboot/mallOrder/buyDet
/xboot/mallOrder/buyList
/xboot/mallOrder/buyerDone
/xboot/mallOrder/checkPay
/xboot/mallOrder/confirm
/xboot/mallOrder/editMaOrder
/xboot/mallOrder/getToken
/xboot/mallOrder/payOrder
```

### mallSku

```
/xboot/mallSku/show
```

### mallSpu

```
/xboot/mallSpu/showSale
```

### marketOrder

```
/xboot/marketOrder/pendingCheck
/xboot/marketOrder/pendingPrice
/xboot/marketOrder/refundApply
/xboot/marketOrder/repay
```

### payWayLimit

```
/xboot/payWayLimit/checkAlAgt
/xboot/payWayLimit/showOne
```

### prkOrder

```
/xboot/prkOrder/buyList
/xboot/prkOrder/checkPay
/xboot/prkOrder/keyCaptchaV2
/xboot/prkOrder/keyCheckV2
/xboot/prkOrder/keyFirstV2
/xboot/prkOrder/keyTokenV2
/xboot/prkOrder/payOrder
/xboot/prkOrder/refundSelf
/xboot/prkOrder/showMyKey
```

### prkSale

```
/xboot/prkSale/listSale
```

### pyAppAuditUser

```
/xboot/pyAppAuditUser/getAu
/xboot/pyAppAuditUser/saveAu
```

### pyAVS

```
/xboot/pyAVS/getAst
```

### pyCommon

```
/xboot/pyCommon/calTechFee
```

### raffleTicket

```
/xboot/raffleTicket/jackDet
/xboot/raffleTicket/myShow
/xboot/raffleTicket/showUser
```

### saOrder

```
/xboot/saOrder/buyList
/xboot/saOrder/checkOrder
/xboot/saOrder/checkPay
/xboot/saOrder/invAsset
/xboot/saOrder/payOrder
/xboot/saOrder/sellList
/xboot/saOrder/steamInvUrl
/xboot/saOrder/storeListNo
```

### saTempToken

```
/xboot/saTempToken/addAll
/xboot/saTempToken/addTokens
/xboot/saTempToken/listTokens
```

### shareAct

```
/xboot/shareAct/create
```

### sharePromo

```
/xboot/sharePromo/appSharePromo
```

### skuSale

```
/xboot/skuSale/showOne
/xboot/skuSale/showPage
```

### steamApp

```
/xboot/steamApp/getDetail
/xboot/steamApp/listUpcoming
/xboot/steamApp/moreLike
/xboot/steamApp/recKey
```

### steamGame

```
/xboot/steamGame/keyHotPublisher
```

### steamKeyOrder

```
/xboot/steamKeyOrder/getByCondition
/xboot/steamKeyOrder/showAdminKey
/xboot/steamKeyOrder/showKey
```

### steamOrder

```
/xboot/steamOrder/buyerDone
/xboot/steamOrder/refundSelf
```

### steamPublisher

```
/xboot/steamPublisher/getList
```

### techFee

```
/xboot/techFee/calc
```

### typeTicket

```
/xboot/typeTicket/getCode
```

### upload

```
/xboot/upload/file
/xboot/upload/fileApp
```

### user

```
/xboot/user/admin/disable/{ids}
/xboot/user/getByCondition
```

### UserCertify

```
/xboot/UserCertify/initialize
/xboot/UserCertify/livePerson
/xboot/UserCertify/queryCertifyNew
```

### userInter

```
/xboot/userInter/saveAddInter
```

### userMission

```
/xboot/userMission/cliTkt
/xboot/userMission/join
/xboot/userMission/show
```

### userReqLog

```
/xboot/userReqLog/getByCondition
```

### userTicket

```
/xboot/userTicket/userList
/xboot/userTicket/userSave
```

### userTicketDetail

```
/xboot/userTicketDetail/getOneDetail
/xboot/userTicketDetail/userSave
```

### usKeyOrder

```
/xboot/usKeyOrder/buyList
/xboot/usKeyOrder/checkPay
/xboot/usKeyOrder/keyCheckV2
/xboot/usKeyOrder/keyFirstV2
/xboot/usKeyOrder/keyTokenV2
/xboot/usKeyOrder/payOrder
```

### usKeySale

```
/xboot/usKeySale/listSale
```

### usSteamGame

```
/xboot/usSteamGame/keyByAppIdCny
```
