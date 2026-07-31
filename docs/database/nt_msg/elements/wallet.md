# elementType 9 — 红包 / 转账

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 9`）。

QQ 钱包相关消息：转账、各类红包。tag 段为 `484xx`。

---

## 一、红包类型（48412）

`RedbagType` 中 TRANSFER / NORMAL / PASSWORD / VOICE 来自早期逆向；
LUCKY(3) 与 DESIGNATED(8) 为**实测确认**（对比同群的拼手气红包与专属红包的 msgBody）。

| 值 | 名称 | 说明 |
| -- | ---- | ---- |
| 1 | TRANSFER | 转账 |
| 2 | NORMAL | 普通红包（等额） |
| 3 | LUCKY | 拼手气红包 |
| 6 | PASSWORD | 口令红包 |
| 8 | DESIGNATED | **专属红包**（指定领取人），会额外带 `48420` |
| 15 | VOICE | 语音红包 |

## 二、主要字段

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 48401 | `walletTargetUin` | uint32 | 目标 uin |
| 48402 | `walletTransferProto` | bytes | 转账 protobuf 字节 |
| 48403 | `walletDetail` | message | 钱包详情，见下 |
| 48409 | `walletOrderId` | string | 订单 ID |
| 48412 | `walletRedbagType` | uint32 | **红包类型**，见上表 |
| 48420 | `walletDesignatedUin` | uint32 | **指定领取人 uin**。只在专属红包（`48412 = 8`）上出现，是唯一被允许领取的群成员 |
| 48421 | `walletExt` | message | 扩展字段，见下 |

## 三、`walletDetail`（48403）

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 48442 | `redbagType` | uint32 | 红包类型（与 48412 呼应） |
| 48443 | `redbagTitle` | string | 红包标题 |
| 48444 | `openPrompt` | string | 「开」的提示文案 |
| 48445 | `subTitle` | string | 副标题 |
| 48448 | `display` | string | 展示文案 |
| 48454 | `orderUrl` | string | 订单链接 |
| 48441 | `flag48441` | uint32 | 未知 |
| 48446 / 48447 | `flag48446` / `flag48447` | string | 未知 |
| 48449 / 48450 | `flag48449` / `flag48450` | uint32 | 未知 |
| 48451 / 48452 / 48453 | `flag4845x` | string | 未知 |
| 48461 | `flag48461` | bytes | 未知 |

## 四、`walletExt`（48421）

注意这个嵌套块用的是**小 tag**（1..8），不是 `484xx` 段。

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 5 | `redbagCover` | string | **红包封面** |
| 3 | `flag3` | bool | 未知 |
| 7 | `flag7` | bool | 未知 |
| 8 | `flag8` | bool | 未知 |

## 五、语义未验证的标量

以下 tag 为往返保真而解析，含义未定：

| tag | 类型 |
| --- | ---- |
| 48404 / 48405 / 48406 / 48407 / 48408 | uint32 |
| 48410 | string |
| 48411 | uint32 |
| 48417 | bytes |
| 48418 | string |
| 48419 | uint32 |
| 48437 / 48438 | uint32 |

---

[← 返回消息段索引](../index.md#消息段element索引)
