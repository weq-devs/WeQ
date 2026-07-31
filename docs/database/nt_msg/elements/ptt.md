# elementType 4 — 语音

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 4`）。

语音（PTT）复用大部分「文件族」tag（`45402`–`45518`、`45815`）承载文件元数据，
共用部分见 [40800 总览 · 第五节](../40800.md#五跨类型共用的文件族字段)。

---

## 一、两个容易踩坑的字段

### 时长看 `45906`，不要看波形

`45906 (pttDuration)` 是唯一可靠的时长来源，同时决定界面上的「时长」标签和气泡宽度。

波形数据 `45925 (waveform)` 是**装饰性**的，不能反推时长：AI 声聊的音频无论多长，
都携带一条固定的 30 字节合成波形。

### AI 声聊看 `45915`

`45915 (isAiVoice)` **只在 AI 声聊片段上出现**（值为 true）；普通麦克风录音、对讲、
其它端发来的语音都不带这个字段。这是唯一可靠的判据 —— QQ 没有其它地方标记它，
而它们的波形又是上面说的合成占位。

## 二、必有字段

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 45402 | `fileName` | string | 文件名 |
| 45403 | `filePath` | string | 本地路径 |
| 45405 | `fileSize` | uint32 | 字节数 |
| 45406 | `md5Bytes` | bytes | 二进制 MD5 |
| 45408 | `contentHash` | bytes | 内容校验 hash |
| 45418 | `isOriginal` | bool | 是否原始音质 |
| 45424 | `md5` | string | 大写十六进制 MD5 |
| 45503 | `fileToken` | string | 下载凭据 |
| 45505 | `uploadTime` | uint32 | 上传时间戳 |
| 45517 | `uploadTimestamp` | uint32 | 上传时间戳 |
| 45518 | `fileTTL` | uint32 | 有效期（秒） |
| 45815 | `summary` | string（repeated） | 摘要 |
| 45906 | `pttDuration` | uint32 | **时长（秒）** |
| 45911 | `voiceChanged` | bool | 是否变声 |
| 45925 | `waveform` | bytes | 波形可视化数据 |

> 字段名之所以叫 `pttDuration` 而不是 `duration`：CALL（通话记录）的 `48152` 也叫
> `duration`，而 `ElementWire` 是扁平结构，键名重复会让 `45906` 被静默丢弃。

## 三、可选字段

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 45915 | `isAiVoice` | bool | **AI 声聊标记**，见上 |
| 45923 | `pttTranscript` | string | **QQ 自带的语音转文字结果**，缓存在行上。跑过一次「转文字」之后才有；转录结果为空时是空字符串 |
| 45905 | `pttVoiceId` | string | 服务端语音 id，如 `98PO#bjWUtk8qVPcpAiG57xZrOeS28AXRNmR` |
| 45550 | `transferState` | uint32 | 传输状态 |
| 45511 | `picTransferState` | uint32 | 传输状态 |
| 45513 | `transferVersion` | uint32 | 传输版本 |

## 四、观测到但语义未验证

| tag | 观测情况 |
| --- | -------- |
| 45903 | 恒为 0 |
| 45907 | PTT 协议标志（uint32） |
| 45909 | uint32，语义未知 |
| 45912 | 取值 2（×39）/ 1（×1） |
| 45922 | uint32，语义未知 |
| 45924 | 只要出现就恒为 1，疑似「转录结果可用」 |
| 45926 | 只要出现就恒为 2 |
| 45908 | 嵌套 `{1, 5, 7}`，所有观测行三项全为 0 |
| 45601 | 嵌套 `{2:{37}, 4:{1,2}}`，所有观测行均为空 / 0，保留为原始字节 |

---

[← 返回消息段索引](../index.md#消息段element索引)
