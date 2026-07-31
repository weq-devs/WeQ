# elementType 23 — 在线文件

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 23`）。

在线文件（QQ 内部名 TOFURECORD）—— 不落地下载、直接在线预览 / 转存的文件。
字段完全复用「文件族」，没有专属 tag，共用部分见
[40800 总览 · 第五节](../40800.md#五跨类型共用的文件族字段)。

---

## 字段

| tag | 字段名 | 类型 | 必有 | 含义 |
| --- | ------ | ---- | ---- | ---- |
| 45402 | `fileName` | string | ✅ | 文件名 |
| 45403 | `filePath` | string | ✅ | 本地路径 |
| 45405 | `fileSize` | uint32 | ✅ | 字节数 |
| 45411 | `imgWidth` | uint32 | ✅ | 宽（图片类文件才有意义） |
| 45412 | `imgHeight` | uint32 | ✅ | 高 |
| 45503 | `fileToken` | string | ✅ | 下载凭据 |
| 45415 | `fileFlag45415` | uint32 | | 文件相关标识 |
| 45504 | `transferFlag45504` | string | | 传输标志 |

---

[← 返回消息段索引](../index.md#消息段element索引)
