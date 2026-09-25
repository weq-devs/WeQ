# AI 声聊（TTS 语音生成，OIDB 0x929b_0）

> 实现：`packages/protocol/src/oidb/send-ai-voice.ts`（协议层，`SendAiVoice`）。
> 本文记录**声线 id 目录**与**试听音频的 URL 构造**，供挑声线时参考。

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

## 二、试听音频：URL 构造

QQ 客户端「AI 声聊」面板里每个声线都有一条静态试听样音，**URL 直接由 voiceId 拼出**，
没有签名、没有查询串、也不需要在线的 QQ 实例：

```
https://res.qpt.qq.com/qpilot/tts_sample/group/<voiceId>.wav
```

例如 `lucy-voice-suxinjiejie`
→ <https://res.qpt.qq.com/qpilot/tts_sample/group/lucy-voice-suxinjiejie.wav>。

- `GET`，返回 `audio/wav`（静态资源，`Server: tencent-cos`），可直接下载 / 试听；
- 除 `lucy-voice-xueling` 是 **16 kHz** 外，其余都是 **32 kHz**、单声道、16-bit PCM；
- 我们**不把样音入库**（每个几十到几百 KB，属于 QQ 的运营资源）；需要试听时按上面的
  模板现拼 URL 即可。voiceId 本身就是要传给 `SendAiVoice` 的 `voiceId`。

## 三、已知声线 id（22 个）

2026-09-26 从 QQ Android 端「AI 声聊」面板的试听请求里抓到的完整目录：

| voiceId | | |
| --- | --- | --- |
| `lucy-voice-f34` | `lucy-voice-f36` | `lucy-voice-f37` |
| `lucy-voice-f38` | `lucy-voice-female1` | `lucy-voice-female2` |
| `lucy-voice-m8` | `lucy-voice-m14` | `lucy-voice-m101` |
| `lucy-voice-male1` | `lucy-voice-male2` | `lucy-voice-male3` |
| `lucy-voice-daji` | `lucy-voice-houge` | `lucy-voice-laibixiaoxin` |
| `lucy-voice-lizeyan-2` | `lucy-voice-lvbu` | `lucy-voice-silang` |
| `lucy-voice-suxinjiejie` | `lucy-voice-xueling` | `lucy-voice-guangxi-m1` |
| `lucy-voice-guangdong-f1` | | |

这是客户端面板上的目录，**不等于**服务端接受的全部 id：`SendAiVoice.invoke` 只把
`voiceId` 透传给服务端，填别的 id 也行，声线不存在时服务端会报错。

---

[← 返回开发者入口](./index.md)
