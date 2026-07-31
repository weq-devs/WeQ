# elementType 14 — Markdown

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 14`）。

富文本 markdown 消息，tag 段为 `487xx`。其中三个用于「QQ 闪传」的嵌套结构
（`48707` / `48708` / `48711`）过于复杂，除 `48708` 外均保留为原始字节 ——
它们属于可选边缘功能，逐字段维护的成本不划算。

---

## 一、必有字段

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 48701 | `markdownContent` | string | **markdown 正文** |
| 48702 | `markdownMeta` | message | 元数据（构建时间戳、标志），见下 |
| 48703 | `markdownFlag48703` | message | 嵌套标志块，见下 |
| 48704 | `markdownFlag48704` | string | 未知的长度分隔字段 |
| 48705 | `markdownTextSummary` | string | 文本摘要 |
| 48706 | `markdownFlag48706` | uint32 | 未知整数标志 |

## 二、`markdownMeta`（48702）

这个嵌套块用的是**小 tag**（1..4）：

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 1 | `flag1` | uint32 | 未知 |
| 2 | `buildTimestamp` | uint32 | 构建时间戳 |
| 3 | `flag3` | bytes | 未知 |
| 4 | `flag4` | uint32 | 未知 |

## 三、`markdownFlag48703`（48703）

与 `48702` 相反，这个嵌套块用的是**绝对 tag**（`487xx` 段）：

| tag | 字段名 | 类型 |
| --- | ------ | ---- |
| 48720 | `field48720` | string |
| 48721 | `field48721` | string |
| 48722 | `field48722` | uint32 |

> 同一个 element 里，一个嵌套块用小 tag、另一个用绝对 tag —— 这是 QQ 的实际做法，
> 不是解析实现的笔误。

## 四、QQ 闪传

| tag | 字段名 | 类型 | 说明 |
| --- | ------ | ---- | ---- |
| 48707 | `flashTransferProto1` | bytes | 复杂嵌套结构，保留为原始字节 |
| 48708 | `flashTransferInfo` | message | 已解析，见下 |
| 48711 | `flashTransferProto3` | bytes | 复杂嵌套结构，保留为原始字节 |

### `flashTransferInfo`（48708）

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 1 | `fileSetId` | string | 文件集 ID |
| 2 | `thumbnailName` | string | 缩略图名称 |
| 3 | `fileBytes` | uint32 | 文件字节数 |
| 4 | `thumbAlt` | message | 缩略图备选，见下 |
| 6 | `createTime` | uint32 | 创建时间 |

`thumbAlt`（48708 → 4）：

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 1 | `fileId` | string | 文件 ID |
| 2 | `urlInfo` | message | `{1: type(uint32), 2: url(string)}` |

---

[← 返回消息段索引](../index.md#消息段element索引)
