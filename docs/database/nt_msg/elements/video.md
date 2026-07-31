# elementType 5 — 视频

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 5`）。

短视频。复用「文件族」tag：`45402` `45405` `45406` `45408` `45411` `45412` `45415`
`45418` `45503` `45505` `45511` `45513` `45517` `45518` `45815`，
共用部分见 [40800 总览 · 第五节](../40800.md#五跨类型共用的文件族字段)。

---

## 一、宽高有两套

视频行上同时存在两组宽高，来源不同：

| 用途 | tag |
| ---- | --- |
| 封面图（缩略图）宽高 | `45411` / `45412`（`imgWidth` / `imgHeight`，文件族共用） |
| **视频本身**宽高 | `45413` / `45414`（`videoWidth` / `videoHeight`） |

## 二、两级过期时间

视频在服务端有**两段**过期：第一次过期下线原片，第二次过期把它从服务端彻底清除。

| tag | 字段名 | 含义 |
| --- | ------ | ---- |
| 45515 | `expireTimestamp` | 第一级过期时间，unix 秒 |
| 45516 | `validPeriodSec` | 有效期长度，秒 |
| 45519 | `secondExpireTimestamp` | 第二级过期时间，unix 秒 |

## 三、必有字段

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 45003 | `subType` | uint32 | 视频文件类型判别式，尚未逐一映射（代码里留有 `VideoSubType` 的 TODO） |
| 45410 | `videoDuration` | uint32 | 时长（秒） |
| 45413 | `videoWidth` | uint32 | 视频宽 |
| 45414 | `videoHeight` | uint32 | 视频高 |
| 45421 | `videoFlag45421` | bytes | 未知字节串 |
| 45422 | `coverFileName` | string | 封面（缩略图）文件名 |
| 45423 | `videoFlag45423` | bool | 未知布尔标志 |
| 45510 | `videoToken` | string | 下载 token |
| 45515 | `expireTimestamp` | uint32 | 见上 |
| 45516 | `validPeriodSec` | uint32 | 见上 |
| 45519 | `secondExpireTimestamp` | uint32 | 见上 |
| 45862 | `channelParams` | bytes | 文件通道参数 |
| 45863 | `videoFlag45863` | uint32 | 未知整数 |

## 四、可选字段

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 45404 | `videoCoverLocalPath` | string | 封面的本地缓存路径（`nt_data/Video/…/Thumb/…_0.png`） |
| 45954 | `fileThumbLocalPath` | string | 缩略图本地缓存路径 |
| 45507 / 45509 | 传输标记 | | 见总览 |

## 五、观测到但语义未验证

| tag | 观测情况 |
| --- | -------- |
| 45852 / 45853 / 45854 | 近似恒为 0（各有一行为 1） |
| 45855 | 恒为 0 |
| 45856 | 嵌套块 `45857..45861`，所有观测行的五个子字段全为空 / 0 |
| 45865 | 取值 0（×30）/ 2（×4） |

## 六、`45851` —— 视频封装格式

本地样本里 `45851` 恒为 2，一度以为是常量；对照 QQ NT 自身的 `NTVideoType` 枚举可知，
它其实是**视频封装格式**——恒为 2 只是因为发到 QQ 的视频几乎都会被转成 MP4。

| 值 | 名称 | 格式 |
| -- | ---- | ---- |
| 1 | VIDEO_FORMAT_AVI | AVI |
| 2 | VIDEO_FORMAT_MP4 | **MP4**（实际观测到的唯一取值） |
| 3 | VIDEO_FORMAT_WMV | WMV |
| 4 | VIDEO_FORMAT_MKV | MKV |
| 5 | VIDEO_FORMAT_RMVB | RMVB |
| 6 | VIDEO_FORMAT_RM | RM |
| 7 | VIDEO_FORMAT_AFS | AFS |
| 8 | VIDEO_FORMAT_MOV | MOV |
| 9 | VIDEO_FORMAT_MOD | MOD |
| 10 | VIDEO_FORMAT_TS | TS |
| 11 | VIDEO_FORMAT_MTS | MTS |

> 枚举仅记录在此文档，未进代码：解析层用不到它，`45851` 目前仍以
> `videoFlag45851` 的名义原样解析、原样回写。

---

[← 返回消息段索引](../index.md#消息段element索引)
