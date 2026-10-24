# QQ 远控协议互通：基础研究

2026-10-25（北京时间）。范围：公开资料与源码静态核查；没有启动 QQ、抓包、发包、加载 AVSDK 或执行远控。本文不是已实现或已互通的验收回执。

## 1. 目标与结论

目标是由 WeQ 实现官方 QQ 远控协议适配，与只使用官方 QQ 的另一端互通；不是通过 QQ 消息执行电脑命令，也不是另建 RustDesk 会话。

- 本轮没有找到可以直接复用的、面向当前 QQ NT 的完整远控线协议文档或独立开源互通实现。这是检索结果，不是断言网上不存在。
- 找到 QQ 团队公开的音视频架构说明，以及社区调用 QQ 自带 AVSDK 的语音桥接源码，可用来寻找协议边界；它们没有证明远控协议已还原。
- 优先追踪 QQ 内核与 AVSDK 的信令交界，确认远控是否走该路径，再决定采集、编解码和输入库。现在选择 RustDesk 为整体引擎为时过早。
- 研究和最小实验可以放在 3.x 独立在线之前；完整产品实现宜接在稳定的会话、推送和重连基础上，但不能把账号心跳当成远控所有链路的必要前提。

## 2. 网上现有材料

### 2.1 QQ 团队的架构说明

来源：[Linux QQ 能打语音视频了！一文详解背后技术实现！](https://cloud.tencent.com/developer/article/2429177)，页面发布于 2024-06-17，来自腾讯云开发者专栏。

文章描述 QQ 音视频从 AVSDK 向 NTRTC 演进，以及 Electron 通过 PPAPI 加载 AVSDKPlugin 的结构。它是寻找模块边界的第一手架构资料，不是远控报文规范；也不能用 2024 年结构保证当前所有版本行为相同。

适用：定位客户端的插件加载与内核交互入口。未解决：远控使用何种会话、键鼠协议、媒体编码、加密或中继。

### 2.2 社区 QQ AV Bridge

项目：[ClaudiaGardner/maibot-qq-voice-call](https://github.com/ClaudiaGardner/maibot-qq-voice-call)。本轮 GitHub API 返回 HEAD：`22f30c021cd3170f75af9dff66cc959a07ebda4b`。以下链接固定至该提交。

| 材料 | 静态核查所得 | 不能据此推导 |
| --- | --- | --- |
| [bridge/README.md](https://github.com/ClaudiaGardner/maibot-qq-voice-call/blob/22f30c021cd3170f75af9dff66cc959a07ebda4b/bridge/README.md) | 方案使用 NapCat 插件和第二个 QQ/Electron 进程加载用户自己的 `libAVSDKPlugin.so` | 不依赖 QQ 的独立音视频协议栈 |
| [bridge/PROTOCOL.md](https://github.com/ClaudiaGardner/maibot-qq-voice-call/blob/22f30c021cd3170f75af9dff66cc959a07ebda4b/bridge/PROTOCOL.md) | 描述本地桥的 HTTP 鉴权、通话状态和音频设备边界 | 文件名中的 Protocol 不是 QQ 的线协议规范 |
| [bridge/napcat-plugin/index.mjs](https://github.com/ClaudiaGardner/maibot-qq-voice-call/blob/22f30c021cd3170f75af9dff66cc959a07ebda4b/bridge/napcat-plugin/index.mjs) | 存在 AVSDK 事件监听、接听参数映射和内核回送代码 | 当前 QQ/本机版本可运行，或已支持远控 |
| [bridge/av-host/host.html](https://github.com/ClaudiaGardner/maibot-qq-voice-call/blob/22f30c021cd3170f75af9dff66cc959a07ebda4b/bridge/av-host/host.html) | 使用 PPAPI embed 和 `postMessage({ cmd, id, param })` 调插件 | 这些插件调用号等于网络命令号 |

可继续追踪的具体边界：

- `getAVSDKService()` / `addKernelAVSDKListener()`。
- `onInviteActionToAVSDK`、`onActionToAVSDK`、`onS2CActionToAVSDK`。
- `setActionFromAVSDK(value[0], value[1])`。
- `buildAcceptParams()` 对回调位置参数进行重排；源码称按 Linux QQ 验证，但本轮未独立运行复核。

这是有代码的语音桥接线索，不是屏幕/键鼠互通证明。是否能借相同边界观察远控，必须由目标 QQ 版本的真实事件或静态调用关系证实。

### 2.3 NapCat 的类型入口

项目：[NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ)。本轮 API 返回 HEAD：`3420f0b76d7dc0ac92cde1663f21ea27f61e13bb`。

[NodeIKernelAVSDKService.ts](https://github.com/NapNeko/NapCatQQ/blob/3420f0b76d7dc0ac92cde1663f21ea27f61e13bb/packages/napcat-core/services/NodeIKernelAVSDKService.ts) 只声明监听器添加、移除和 `isNull()`，没有完整事件结构或远控方法。社区桥代码还使用了该类型文件未声明的方法，因此不能把类型声明当成运行时能力的完整清单，也不能只按它生成实现。

### 2.4 排除的搜索结果

检索覆盖中文远程协助/远程控制、英文 remote assistance、QQNT/AVSDK/NTRTC，以及 RemoteControl/RemoteAssist 等源码关键词。普通搜索结果较多混入：

- 通过 QQ Bot/OneBot 接收文本命令、截图或操作 AI Agent 的项目：不实现官方 QQ 远控互通。
- 腾讯云 TRTC 屏幕共享 SDK：云产品接入资料不能证明可进入 QQ 私有会话，不能把产品亲缘关系等同于协议兼容。
- 旧 QQ/OICQ 的流量识别与一般操作教程：没有目标版本的完整握手、密钥与控制消息证据。
- 缺少源码、包样本或可复现实验的聚合文章：未作为具体协议结论依据。

## 3. 与 WeQ 现有实现对照

本轮额外核对 `packages/protocol/src/call/signaling.ts` 的源码：

- 私聊已有 `SsoCreateRoom`、`SsoInviteUser`、`SsoAcceptInvite`、`SsoLogOut` 命令定义，前缀为 `trpc.qqrtc.av_appsvr.AvAppsvr`。
- `CALL_SCENE` 有语音、视频、邀请和挂断相关值，未建立独立远控场景定义。不能把通话记录的枚举值直接填入这里。
- `docs/database/nt_msg/elements/call.md` 的 `SCREEN_SHARE = 3`、`REMOTE_ASSIST = 5` 是通话记录字段语义，不是已验证的远控建房参数。
- `docs/develop/voice-call-20261023.md` 记录语音信令、GCS 控制面、媒体与中继分层，并记录接听推送的限制。命令或 schema 存在不等于接听链路已验收；文档也可能落后于源码。
- `docs/develop/nt-helper-interface.md` 说明账号在线与心跳由 QQ 本体维持。这不能证明远控连接必须依赖同一心跳，也不能证明接管心跳后远控推送自然到达。

目前没有证据确认 QQ NT 远控与上述语音房间共用完整协议。共用 AVSDK/QQRTC 只能作为调查假设。

## 4. 下一步最小验证

先限定一个支持远控的目标 QQ 平台、精确版本和双方授权的测试环境，不预设 macOS/Linux 与 Windows 的功能相同。

| 问题 | 最小证据 | 能推翻假设的反例 |
| --- | --- | --- |
| 远控是否经过 AVSDK 内核交界 | 对照语音、屏幕共享、远控的事件名、方向、脱敏结构与时间线 | 语音有对应事件，远控走独立服务或模块 |
| 远控是否复用当前 QQRTC 信令 | 发起、接受、拒绝、取消、结束时的实际命令和关联标识 | 没有对应命令，或存在另一组建会话/鉴权命令 |
| 何处授予与收回控制权 | 仅观看、申请控制、同意、撤销的差分事件 | 控制权仅在独立数据通道协商，不出现在账号信令里 |
| 画面能否用通用解码器处理 | 协商结果、解密/去封包后的合成画面帧与独立解码结果 | 编码为专有变体或需要额外元数据，通用解码失败 |
| 独立在线是否为前置 | 确认邀请与推送路由，区分账号和远控保活 | 主动发起即可完整建立所需数据通道，或推送仍只交给 QQ 本体 |

本轮没有执行这些实验。下一阶段先观察与建模，不自动批准远控、注入输入或重放真实票据。研究记录保留必要版本信息，样本去除账号、票据、地址和个人画面；回归测试使用合成或脱敏黄金样本。

## 5. 对架构与排期的影响

短期可以借 QQ 自带 AVSDK 的边界研究协议，但运行插件不等于完成翻译层。最终目标若为独立协议实现，应逐步用 WeQ 的信令/传输适配替代 QQ 内核依赖。

RustDesk 或独立开源库只在已确认的边界上选用：采集、标准编解码、系统输入等。不能假设 RustDesk 网络握手可替代 QQ 鉴权，也不能预先认定 QQ 输入事件与 RustDesk 一一对应。源码复用另行审查具体文件许可。

建议排期：现在完成协议边界调查和样本模型；3.x 独立会话设计预留业务推送分发与生命周期接口；待账号会话和实际远控传输契约清楚后，再实现完整双向互通。是否必须等账号心跳接管，由实验结果决定，不设为先验硬门禁。
