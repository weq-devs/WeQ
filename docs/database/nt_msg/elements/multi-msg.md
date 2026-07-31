# elementType 16 — 合并转发

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 16`）。

合并转发（QQ 内部名 MULTIFORWARD）。element 本身**只是一张卡片壳**：
三个字段分别是服务端资源 id、渲染用的 XML 预览、以及上传会话 id。
真正的消息链条要么去服务端拉（凭 `resId`），要么读本地 [40900 列](../40900.md) 的缓存。

---

## 一、字段

| tag | 字段名 | 类型 | 必有 | 含义 |
| --- | ------ | ---- | ---- | ---- |
| 48601 | `resId` | string | ✅ | **服务端资源 ID**，用于向 QQ 服务器拉取完整消息链 |
| 48602 | `xmlContent` | string | ✅ | **XML 预览文档**，携带标题、摘要与元数据，用于渲染转发卡片 |
| 48603 | `sessionId` | string | ✅ | 关联本次上传会话的标识，在 XML 中体现为 `m_fileName` |

## 二、`xmlContent`（48602）的结构

```ts
interface MultiMsgXmlPayload {
  serviceID: string;
  templateID: string;
  action: string;
  brief: string;         // 会话列表外显的简述
  m_resid: string;       // 与 48601 对应
  m_fileName: string;    // 与 48603 对应
  tSum: string;          // 条数
  flag: string;
  item?: {
    layout: string;
    titles: Array<{ color: string; size: string; text: string }>;  // 预览的前几条
    summary?: { color: string; text: string };                     // 「查看 N 条转发消息」
  };
  source?: { name: string };
}
```

## 三、与 40900 的关系

一条合并转发消息的行级 `40011 = 8`（`MsgType.MULTI_FORWARD`），此时该行的
[`40900` 列](../40900.md)里存着被转发消息的**完整快照**（每条都是一个 `MsgCache`，
含各自的 `40800` 正文）。

也就是说：

- **离线可读**：不联网也能展开转发内容，因为快照就在本地库里；
- **可递归**：被转发的消息若本身也是合并转发，`40900` 会再嵌套一层。

---

[← 返回消息段索引](../index.md#消息段element索引)
