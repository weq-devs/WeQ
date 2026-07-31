# elementType 30 — 在线文件夹

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 30`）。

在线文件夹。结构与[在线文件](./online-file.md)几乎一致，只是没有宽高
（文件夹没有尺寸概念）。字段全部复用「文件族」，见
[40800 总览 · 第五节](../40800.md#五跨类型共用的文件族字段)。

---

## 字段

| tag | 字段名 | 类型 | 必有 | 含义 |
| --- | ------ | ---- | ---- | ---- |
| 45402 | `fileName` | string | ✅ | 文件夹名 |
| 45403 | `filePath` | string | ✅ | 本地路径 |
| 45405 | `fileSize` | uint32 | ✅ | 总字节数 |
| 45503 | `fileToken` | string | ✅ | 下载凭据 |
| 45415 | `fileFlag45415` | uint32 | | 文件相关标识 |
| 45504 | `transferFlag45504` | string | | 传输标志 |

---

[← 返回消息段索引](../index.md#消息段element索引)
