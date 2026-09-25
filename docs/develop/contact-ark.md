# 推荐联系人 / 推荐群 Ark 卡片（取卡 + 发送）

> 实现：`packages/protocol/src/oidb/send-contact-ark.ts`（取卡 + 发送二合一）。
> 搬运自 SnowLuma 的 `oidb-services/contacts/get-buddy-recommend-ark.ts` /
> `get-group-recommend-ark.ts`；那边只**取**卡，WeQ 把「取」和「发」接成一步。

## 一、它是什么

聊天里那种「推荐好友」「推荐群」卡片（QQ 客户端里点名片 / 群资料页的「分享」得到
的就是它）。它**不是**一条发送协议，而是两步：

```
第 1 步  服务端生成卡片 JSON（ark）
  好友   OidbSvcTrpcTcp.0x12b6_0  getBuddyRecommendContactArkJson
         请求 {1:uin, 2:phone, 3:jump_url}   响应 {1:ark}
  群聊   OidbSvcTrpcTcp.0x8b7_5   getGroupRecommendContactArkJson   （uin-form 信封）
         请求 {1:reqType=1, 2:groupCode, 5:flag=1}   响应 {1:errCode, 5:arkJson}

第 2 步  把 ark JSON 当 lightApp 元素发出去
         MessageSvc.PbSendMsg，元素 { kind: 'ark', arkData: <第 1 步的 JSON> }
```

两步都由 `sendContactArk()` 一次跑完；只想拿 JSON 不发的时候用 `getContactArk()`。

### 容易搞混的两个 id

| 参数 | 含义 | 取值 |
| --- | --- | --- |
| `targetId` | 卡片**发到哪**（聊天目标） | 群号，或对方 QQ 号 |
| `contactId` | 卡片**推荐谁** | 被推荐的好友 QQ 号，或被推荐的群号 |

两者可以相同（比如往某个群里发一张推荐这个群自己的卡），但语义上必须分开传。

## 二、两个字段细节（抄错就发不出去 / 卡片跳转不对）

**好友卡的 `jump_url` 是客户端内核硬编码的**，服务端只是把它原样回填进卡片：

```
mqqapi://card/show_pslcard?src_type=internal&source=sharecard&version=1&uin=<uin>
```

`phone` 缺省写 `'-'`（不是空串）—— NT 客户端就是这么写的，空串会走成字段缺失。

**两条协议的 OIDB 信封形式不同**：好友 `0x12b6_0` 是普通信封，群 `0x8b7_5` 是
uin-form（`reserved=1`）。SnowLuma 早期把好友卡记成 `0x9130_0` + uin-form，
已在 #149 修正为 `0x12b6_0` + 普通信封；搬运时照的是修正后的版本。

## 三、失败怎么暴露

| 情况 | 行为 |
| --- | --- |
| 取卡回包没有 ark 字段（空串） | **抛错**，不发一张空白卡 |
| 参数非法（非正整数） | 取卡前抛错，一个包都不发 |
| 发送被服务端拒绝 | **不抛**，放到 `result.receipt`，`receipt.ok === false` |

发送复用 `MessageSvc.PbSendMsg` 的回执口径（与 `send-message.md` 一致）：群聊看
`groupSequence`、私聊看 `privateSequence`，`result != 0` 或响应体为空即 `ok: false`。
调用方必须检查 `receipt.ok`，不要拿「没抛异常」当发送成功。

## 四、用法

```ts
import { sendContactArk, sendBuddyContactArk, sendGroupContactArk } from '@weq/protocol';

// 往群里发一张推荐好友 10000 的卡片
const r1 = await sendContactArk(nt, pid, {
  peerType: 'group', targetId: 666, kind: 'qq', contactId: 10000,
});

// 往私聊发一张推荐群 555 的卡片（kind 预置的薄封装）
const r2 = await sendGroupContactArk(nt, pid, {
  peerType: 'c2c', targetId: 10000, contactId: 555, userUid: 'u_xxx',
});

if (!r2.receipt.ok) {
  // 服务端拒绝：r2.receipt.result / r2.receipt.errMsg
}
```

---

[← 返回开发者入口](./index.md)
