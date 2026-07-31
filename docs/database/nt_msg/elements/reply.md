# elementType 7 — 回复引用

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 7`）。

引用一条更早的消息。回复元素**自带被引用消息的快照**（`47423`），
所以即使原消息已被删除，引用块依然能渲染出内容。

> 与 [40900 列](../40900.md) 的关系：行级 `40011 = 9` 时，`40900` 列里也存了一份
> 被引用消息的**完整行快照**。`47423` 是元素内的轻量副本，`40900` 是列级的完整副本，
> 两者并存、粒度不同。

---

## 一、被引用消息的定位

| tag | 字段名 | 类型 | 必有 | 含义 |
| --- | ------ | ---- | ---- | ---- |
| 40020 | `origSenderUid` | string | ✅ | 原消息发送者 uid（复用信封级 tag） |
| 40021 | `origReceiverUid` | string | ✅ | 原消息接收者 uid（复用信封级 tag） |
| 47402 | `origMsgSeq` | uint32 | ✅ | 原消息序列号 |
| 47403 | `origSenderUin` | uint32 | ✅ | 原消息发送者 QQ 号 |
| 47404 | `origMsgTime` | uint32 | ✅ | 原消息时间戳，unix 秒 |
| 47411 | `origReceiverUin` | uint32 | ✅ | 原消息接收者 QQ 号 |
| 47416 | `origMsgId` | uint64 | ✅ | 原消息 id |
| 47419 | `origMsgIndex` | uint32 | ✅ | 原消息在会话内的序号 |
| 47401 | `replyOrigMsgIdRef` | uint64 | | 原消息 id 引用 |
| 48101 | `replyOrigMsgSeqCopy` | uint32 | | `47402` 的副本 —— 所有观测行完全相同 |

> 群聊里 `origReceiverUid` / `origMsgIndex` 常常缺失。WeQ 自己构造回复时会填无害的占位值。

## 二、被引用内容的快照

| tag | 字段名 | 类型 | 必有 | 含义 |
| --- | ------ | ---- | ---- | ---- |
| 47423 | `origElements` | repeated `ReplyElementWire` | ✅ | **原消息 element 的轻量快照** |
| 47413 | `replyTextSummary` | string | | 原消息的文本摘要 |
| 47421 | `replyOrigSenderNick` | string | | 被回复者的群名片 / 昵称 |
| 47410 | `replyOrigSenderBlob` | bytes | | 被引用消息发送者的完整快照（uin、uid、群名片、seq/time…）。嵌套很深，且携带的信息 `47402..47423` 已全部提供，故保留为原始字节 |

### `ReplyElementWire`（47423 的每一项）

结构是 `ElementWire` 的**裁剪版**：`elementId` + `elementType` 打头，
后面跟着「实际出现在 wire 上的」各类型字段。由于捕获时并不知道原消息是什么类型，
除前两项外**全部可选**：

- 通用：`45001` `45002` `45003`
- 文本：`45101`
- 文件族：`45402` `45403` `45405` `45406` `45407` `45408` `45411` `45412` `45416`
  `45418` `45424` `45503` `45505` `45511` `45513` `45517` `45518` `45550`
  `45802` `45803` `45804` `45815` `45816`
- 语音：`45906` `45911` `45915` `45925`
- 表情：`47601` `47602`
- ARK：`47901`
- 合并转发：`48601` `48602` `48603`

## 三、语义未验证的字段

| tag | 字段名 | 类型 | 观测情况 |
| --- | ------ | ---- | -------- |
| 47422 | `replyFlag47422` | uint64 | 必有。大小接近 `elementId` |
| 47405 | `replyFlag47405` | uint32 | 取值 1（×290）/ 0（×14） |
| 47407 | `replyFlag47407` | uint32 | 取值 1（×207）/ 0（×96） |
| 47415 | `replyFlag47415` | bool | 未知 |
| 47418 | `replyFlag47418` | bool | 未知 |
| 47424 | `replyFlag47424` | uint32 | 恒为 1 |
| 47425 | `replyFlag47425` | uint32 | 恒为 1 |

---

[← 返回消息段索引](../index.md#消息段element索引)
