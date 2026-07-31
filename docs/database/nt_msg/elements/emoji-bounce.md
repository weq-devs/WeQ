# elementType 27 — 弹射表情

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 27`）。

表情弹射（QQ 内部名 FACEBUBBLE）—— 会「弹进」聊天窗口的动画表情。tag 段为 `521xx`。

---

## 一、字段

下列字段在 EMOJI_BOUNCE element 上都是必有的。

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 52132 | `emojiBounceId` | uint32 | 弹射表情 id |
| 52133 | `emojiBounceFlag52133` | bool | 未知布尔标志 |
| 52134 | `emojiBounceName` | string | 弹射表情名称 |
| 52137 | `emojiBounceDetail` | message | 嵌套详情，见下 |
| 52138 | `emojiBounceTextSummary` | string | **文本总结（含弹射个数）** |
| 52139 | `emojiBouncePcText` | string | 电脑端显示文本 |

## 二、`emojiBounceDetail`（52137）

冗余地重复了一份表情名称与文本摘要：

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 52142 | `flag52142` | uint32 | 未知 |
| 52143 | `name` | string | 名称（同 52134） |
| 52144 | `textSummary` | string | 文本摘要（同 52138） |

---

[← 返回消息段索引](../index.md#消息段element索引)
