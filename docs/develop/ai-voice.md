# AI 声聊（声线目录 0x929d_0 + 语音合成 0x929b_0）

> 合成实现：`packages/protocol/src/oidb/send-ai-voice.ts`（协议层，`SendAiVoice`）。
> 本文记录**声线目录**（命令、分组、中文名）与**试听音频的 URL 构造**。
>
> 两条命令是分开的：**0x929d_0 列声线**、**0x929b_0 合成语音**。我们只实现了后者，
> 目录目前硬编码在前端（`apps/desktop/src/renderer/src/im-template/template/aiVoicePanel.tsx`）。

## 一、它是什么

`0x929b_0` 把「文字 + 声线 id」交给服务端合成语音，回包只带**音频文件索引**
（md5 / sha1 / 文件名 / 大小 / 下载票据）——它**不发送消息**，要发出去还得再走
`MessageSvc.PbSendMsg`（`send_media_message` 的 `record` 管线）。**只支持群聊**。

请求内层字段（详见源文件头注释，由真机抓包 + 服务端错误回显反推）：

| tag | 字段 | 说明 |
| --- | --- | --- |
| 1 | `groupCode` | 群号（填私聊 uin/uid 一律不认） |
| 2 | `voiceId` | 声线 id，如 `lucy-voice-suxinjiejie` |
| 3 | `text` | 要合成的文字 |
| 4 | `chatType` | 1 = 群聊；2 服务端认结构但回 70001 |
| 5 | `clientMsgInfo` | `{ msgRandom }` |

## 二、声线目录（OIDB 0x929d_0）

客户端「AI 声聊」面板的声线列表不是本地写死的，走一条独立的目录 OIDB：

| | |
| --- | --- |
| 命令 | `OidbSvcTrpcTcp.0x929d_0` |
| 外层 | `f1 = 0x929d`（command）、`f2 = 0`（subCommand）、`f4 = 响应体` |
| 响应体 | repeated `f1 = 分组` |

分组与条目（字段名由 wire 结构反推，tag 都是 protobuf 的默认小 tag）：

```
group  f1 = 分组名（推荐 / 搞怪 / 古风 / 现代）
       f2 = repeated item

item   f1 = voiceId   （字符串，要原样发给 0x929b_0 的 voiceId）
       f2 = 中文名     （字符串，面板上的显示名，如「酥心御姐」）
       f3 = 样音 URL   （字符串 .wav）
```

实测（2026-09-26，群号 673646675 的会话）返回 **4 组 / 30 条**，按 `voiceId` 去重后
**22 个**。**同一条声线会出现在多个分组**，不是互斥分类：

| 分组 | 条数 | 成员 |
| --- | --- | --- |
| 推荐 | 8 | 小新、猴哥、四郎、东北老妹儿、广西大表哥、妲己、霸道总裁、酥心御姐 |
| 搞怪 | 7 | 小新、猴哥、东北老妹儿、广西大表哥、说书先生、憨憨小弟、憨厚老哥 |
| 古风 | 3 | 妲己、四郎、吕布 |
| 现代 | 12 | 霸道总裁、酥心御姐、元气少女、文艺少女、磁性大叔、邻家小妹、低沉男声、傲娇少女、爹系男友、暖心姐姐、温柔妹妹、书香少女 |

### voiceId 与中文名（22 个）

| voiceId | 中文名 | 分组 |
| --- | --- | --- |
| `lucy-voice-laibixiaoxin` | 小新 | 推荐 / 搞怪 |
| `lucy-voice-houge` | 猴哥 | 推荐 / 搞怪 |
| `lucy-voice-guangdong-f1` | 东北老妹儿 | 推荐 / 搞怪 |
| `lucy-voice-guangxi-m1` | 广西大表哥 | 推荐 / 搞怪 |
| `lucy-voice-daji` | 妲己 | 推荐 / 古风 |
| `lucy-voice-silang` | 四郎 | 推荐 / 古风 |
| `lucy-voice-lizeyan` | 霸道总裁 | 推荐 / 现代 |
| `lucy-voice-suxinjiejie` | 酥心御姐 | 推荐 / 现代 |
| `lucy-voice-m8` | 说书先生 | 搞怪 |
| `lucy-voice-male1` | 憨憨小弟 | 搞怪 |
| `lucy-voice-male3` | 憨厚老哥 | 搞怪 |
| `lucy-voice-lvbu` | 吕布 | 古风 |
| `lucy-voice-xueling` | 元气少女 | 现代 |
| `lucy-voice-f37` | 文艺少女 | 现代 |
| `lucy-voice-male2` | 磁性大叔 | 现代 |
| `lucy-voice-female1` | 邻家小妹 | 现代 |
| `lucy-voice-m14` | 低沉男声 | 现代 |
| `lucy-voice-f38` | 傲娇少女 | 现代 |
| `lucy-voice-m101` | 爹系男友 | 现代 |
| `lucy-voice-female2` | 暖心姐姐 | 现代 |
| `lucy-voice-f36` | 温柔妹妹 | 现代 |
| `lucy-voice-f34` | 书香少女 | 现代 |

## 三、试听音频：URL 构造

每个声线都有一条静态试听样音。目录响应里**已经给了完整 URL**（`item.f3`），
格式固定，没有签名、没有查询串、也不需要在线的 QQ 实例：

```
https://res.qpt.qq.com/qpilot/tts_sample/group/<样音文件名>.wav
```

例如 <https://res.qpt.qq.com/qpilot/tts_sample/group/lucy-voice-suxinjiejie.wav>。

> ⚠️ **不要拿 `voiceId` 直接拼样音 URL。** 两者**通常**相同，但不保证：
> `lucy-voice-lizeyan`（霸道总裁）的样音文件是 `lucy-voice-lizeyan-2.wav`。
> 以目录响应里的 `item.f3` 为准（前端因此把样音文件名单独记了一份，见
> `aiVoicePanel.tsx` 的 `AI_VOICE_CATALOG[].sample`）。

- `GET`，返回 `audio/wav`（静态资源，`Server: tencent-cos`），可直接下载 / 试听；
- 除 `lucy-voice-xueling` 是 **16 kHz** 外，其余都是 **32 kHz**、单声道、16-bit PCM；
- 我们**不把样音入库**（每个几十到几百 KB，属于 QQ 的运营资源）；需要试听时按上面的
  模板现拼 URL 即可。`voiceId` 本身就是要传给 `SendAiVoice` 的 `voiceId`。

## 四、与合成（0x929b_0）的关系

目录（0x929d_0）只负责「有哪些声线、叫什么、样音在哪」；真正把文字合成语音的是
前面第一节的 `0x929b_0`。两者是**两条独立的 OIDB**，我们目前只实现了后者
（`packages/protocol/src/oidb/send-ai-voice.ts`）—— 目录是硬编码在前端
（`aiVoicePanel.tsx` 的 `AI_VOICE_CATALOG`），没有走协议。

---

[← 返回开发者入口](./index.md)
