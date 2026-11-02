# 群礼物面板协议

2026-11-03 抓包整理。群礼物面板走裸 SSO：

```
trpc.qqva.gift_midground_panel.GiftMidgroundPanel.SsoGetSceneItem
```

**不签名**（抓包 reserved 里没有 `SecInfo`，`needSign = false`），返回一个回包带回
全部页签和礼物。实现见 `@weq/protocol` 的 `oidb/misc/group-gift-panel.ts`，
账户级方法由 `GroupGiftService` 提供（桌面端包一层 `account.groupGift.scene`）。

## 请求

抓包 SEND 55 字节 = 4 字节长度前缀 + 51 字节 body：

```
0a 05 "10012"   12 00   18 02
2a 26 { 08 03   22 22 { 0a 07 "android" 12 0c "9.3.75.42350" 1a 09 "<群号>" } }
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| 1 | string | 场景 id，群礼物固定 `10012` |
| 2 | string | 抓包里是空串，但**在 wire 上**，编码时必须保留 |
| 3 | uint32 | 抓包固定 `2` |
| 5 | message | 客户端信息 |
| 5.1 | uint32 | 平台，`3` = Android |
| 5.4 | message | `{ 1 os, 2 version, 3 群号 }`；version 用抓包里的 Android QQ 版本 |

`5.4.3` 是**群号**，不是自己的 uin。PC 端凭据发送同样的 body 也能拿到全量数据，
说明这个列表不绑发送方身份；用哪个在线账号发都不影响结果。

## 回包

外层（`respSchema`）：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| 4 | message | 面板本体 |
| 5 | repeated KV | 外层上报字段（`ReportTabID` / `ReportFlowID`） |
| 6 | uint32 | 场景类型，抓包为 `1` |
| 7 | message | `{ 3 场景标题 }`，抓包为「福利」 |

面板本体：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| 1 | string | 面板 id，抓包为 `025d64c9` |
| 2 | string | 面板名，抓包为「默认/兜底面板勿删」 |
| 3 | repeated | 页签 |
| 7 | message | `{ 1 flowId, 2 tabId }` 面板上报 id |

页签字段：`1` id、`2` 名称（热门 / 恋爱ing / 生日快乐）、`3` 排序、`4` 副标题、
`5` 礼物列表、`6` 属性 KV（`isFanClubTab`）。

礼物条目：

| 字段 | 含义 |
| --- | --- |
| 1 | 条目 id（`300434` 这类，做列表稳定 key） |
| 2 | 名称 |
| 3 | `MarketingProductID` |
| 4 | 场景 id（部分礼物才有） |
| 5 | 明细 |
| 6 | 角标 `{ 1 id, 2 文案, 3 图标, 5 类型 }` |
| 8 | 标语（如「送你一朵小红花！」） |
| 9 | 属性 KV：`charm` 魅力值、`desc` 描述、`giftType`、`luxury`、`giftPay` … |
| 11 | 排序 |
| 12 | 素材追踪 `{ 1 traceId, 2 resourceId }` |

明细字段：`1` 礼物 id、`2` 名称、`3` 等级、`4` **金币价**、`9` 标签、
`11` 图片资源、`14` 素材 id。

图片资源 `11`：

- `2` 是 `{ 1 文件名, 2 URL }` 列表，取 `staticPreviewImage.png` 做列表 / 详情预览，
  没有静态图时退回 `dynamicPreviewImage.png`；
- `1` 的 `*.pag` 与 `2` 里的 `all.zip` 是客户端动画素材，WeQ 不用；
- `3` 是素材根目录。

所以卡片上的「2金币 / 魅力值+2」来自 `detail.4` 与 `attrs.charm`，与真机一致。

## 渲染层

- 群聊输入框的「红包 / 礼物」菜单里「礼物」打开 `GroupGiftPanel`（私聊仍是
  `GiftMallPanel`）。群聊面板**只读**：没有祝福语、匿名开关和「赠送」按钮。
- 礼物图继续走 `weq-media://gift`（只放行 `*.gtimg.cn`），`tianquan.gtimg.cn`
  的预览图可以直接显示。
- 没有在线 QQ / 完全离线时主进程会报错；渲染层回落到 2026-11-03 抓包生成的内置
  目录（`groupGiftFallback.ts`），并同时弹错误 toast 明确说明「不是实时数据」。
