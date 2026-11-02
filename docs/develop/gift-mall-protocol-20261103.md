# QQ 礼物商城协议

本文记录礼物商城首页、查询、礼物墙和赠送下单接口。抓包中的 Cookie、p_skey、UIN、订单号、支付 token 和礼物祝福内容均不入文档。

## 接口与凭据

| 用途 | 接口 | 凭据域 |
| --- | --- | --- |
| 首页推荐、愿望单、服务端页签 | `GiftMall/GetHomePageExtraInfo` | `vip.qq.com` |
| 首页礼物列表 | `GiftMall/GetHomePageGiftList` | `vip.qq.com` |
| 礼物搜索 | `GiftMall/SearchGifts` | `vip.qq.com` |
| 礼物详情 | `GiftMall/GetSingleGiftInfo` | `vip.qq.com` |
| 会员权益 | `GiftMall/GetVipInfo` | `vip.qq.com` |
| 送出/收到的礼物墙 | `GiftMall/GetSendRecvWallListV2` | `vip.qq.com` |
| 赠送/购买下单 | `commonpay/BuyItem` | `qzone.qq.com` |
| AI 内容披露状态 | `ugc/Ugc/GetAIDiscStatus` | `vip.qq.com` |

Service 从 `WebCredentialProvider` 获取对应域的当前 p_skey，不使用抓包中的旧票据。礼物商城查询请求带 `g_tk = computeBkn(pskey)`；`BuyItem` 抓包没有 `g_tk` 参数。

## 首页分类与分页

`GetHomePageGiftList` 的请求通过 `tab_name` 和 `sub_tab_name` 选择分类。空 `tab_name` 表示全部；空子标签数组保留服务端默认的「最近上新」。支持的分类和子标签定义在 `@weq/protocol`：

- 全部：默认最近上新，也可选鲜花、玩偶摆件、礼品卡、蛋糕。
- 礼品卡：音乐会员、视频会员、其他会员、QQ权益。
- 个性化装扮：主题、气泡、头像挂件。

列表请求同时携带 `batch_num`、`recommand_type`、`attach_info`、`is_new_mall`、`crowd_tab` 和收礼人 UIN。响应的 `attachInfo` 与 `isEnd` 原样返回给调用方，service 不推断游标内容。

搜索请求使用 `key_word`、`pagination.page_no/page_size`、`attach_info` 和收礼人 UIN。礼物墙使用 `is_send` 区分送出/收到记录，并将响应的 `extInfo`、`beginTime` 原样传回后续页请求。

## 详情与下单

详情接口请求字段名为 `gift_id`，响应商品标识为 `giftInfo.giftId`。抓包中的 `BuyItem.item_id` 与 `itemList[0].itemId` 都等于该 `giftId`。

两个下单抓包的 `itemSubId` 结构一致。协议 builder 根据礼物 ID、目录价格、发送/接收 UIN、匿名开关和 `freeSendType` 生成字段；抓包还包含空的 `undefined_boxPrice`、`undefined_muin` 项和 `source:undefined`，当前按原始形状保留。`gift_prize` 使用详情中的 `svipDiscount`，`map_ext` 由调用方完整传入，避免推断 `byCount` 等客户端状态字段。

免费样本的业务类型为 `1013`，付费样本为 `1064`。当前 API 要求调用方显式指定 `businessType`，不根据会员资格自动选择。`BuyItem` 写请求只发送一次，不自动重放；付费响应中若含订单和支付字段，service 原样返回，不执行付款。

下单前调用方必须传入 `beforeSend` 回调以完成上层确认。`sendGift` 使用 `qzone.qq.com` 凭据；首页/搜索/详情/礼物墙使用 `vip.qq.com` 凭据。

## API

纯请求体 builder 与响应类型位于 `packages/protocol/src/web/gift-mall.ts`，账户级方法由 `WebQueryService` 提供：

- `getGiftMallHomePageExtraInfo`
- `getGiftMallGiftList`
- `searchGiftMall`
- `getGiftMallSingleGiftInfo`
- `getGiftMallVipInfo`
- `getGiftMallWall`
- `getGiftMallAIDiscStatus`
- `sendGift`
