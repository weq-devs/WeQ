# elementType 3 — 文件

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 3`）。

通用文件传输。大量复用「文件族」共用 tag，共用部分见
[40800 总览 · 第五节](../40800.md#五跨类型共用的文件族字段)。

---

## 一、复用自文件族的字段

| tag | 字段名 | 说明 |
| --- | ------ | ---- |
| 45402 | `fileName` | 文件名 |
| 45403 | `filePath` | 本地路径 |
| 45405 | `fileSize` | 字节数 |
| 45406 | `md5Bytes` | 二进制 MD5 |
| 45408 | `contentHash` | 内容校验 hash |
| 45411 / 45412 | `imgWidth` / `imgHeight` | 宽高（图片类文件才有意义） |
| 45415 | `fileFlag45415` | 文件相关标识 |
| 45503 | `fileToken` | 下载凭据 |
| 45504 | `transferFlag45504` | 传输标志（string） |
| 45505 | `uploadTime` | 上传 / 处理时间戳 |
| 45510 | `videoToken` | 下载 token |
| 45511 | `picTransferState` | 传输状态 |
| 45513 | `transferVersion` | 传输版本 |
| 45550 | `transferState` | 传输状态 |

> `45510` 曾被误标为 `fileFlag45510`，实为下载 token，VIDEO 与 FILE 共用。

## 二、FILE 专属字段

### 必有

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 45003 | `subType` | uint32 | 文件类型判别式，观测到约 20 种取值，尚未逐一映射（代码里留有 `FileSubType` 的 TODO） |
| 45407 | `md5Bytes2` | bytes | 第二份 MD5，形状与作用同 45406 |
| 45409 | `fileFlag45409` | bytes | 未知字节串 |
| 45501 | `fileFlag45501` | uint32 | 未知整数（可能是 bool） |
| 45512 | `fileFlag45512` | bool | 未知布尔标志 |
| 45514 | `fileFlag45514` | bool | 未知布尔标志 |

### 可选

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 45554 | `transferErrorText` | string | 人类可读的传输错误，如「传输失败，请稍后重试」 |
| 45533 | `fileFlag45533` | uint32 | 仅在一条 subType=4 的行上观测到（值为 2） |
| 45951 | `fileThumbPathRemote` | string | **发送端**的缩略图路径（手机端，`.thumbnails/…`） |
| 45953 | `fileThumbPathRemote2` | string | 发送端的第二个缩略图路径（`qlarge-dsc-…`） |
| 45954 | `fileThumbLocalPath` | string | 本机缓存的缩略图路径（`nt_data/File/Thumb/…`） |
| 45966 | `fileFlag45966` | bytes | 所有观测行均为空 |
| 45967 | `fileFlag45967` | bytes | 所有观测行均为空 |
| 45968 | `fileGroupMeta` | bytes | 群文件元数据块（上传者 uin / 昵称、文件 uuid、上传时间…）。仅观测到一次，子 tag 未验证，故保留为原始字节 |
| 45507 / 45509 | 传输标记 | | 见总览 |

---

[← 返回消息段索引](../index.md#消息段element索引)
