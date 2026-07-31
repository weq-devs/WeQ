# elementType 21 — 通话记录

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 21`）。

音视频通话记录（QQ 内部名 AVRECORD）：语音通话、视频通话、屏幕共享、远程协助的结果条目。

---

## 一、字段

| tag | 字段名 | 类型 | 必有 | 含义 |
| --- | ------ | ---- | ---- | ---- |
| 48151 | `answerType` | uint32 | ✅ | 接听 / 挂断类型，与 `subType` 一致，取值见 `CallSubType` |
| 48152 | `duration` | uint32 | ✅ | **通话时长（毫秒）** |
| 48154 | `callMethod` | uint32 | ✅ | **通话方式**，见下表 |
| 48157 | `callSummary` | string（repeated） | ✅ | 通话摘要文案 |
| 48153 | `callFlag48153` | string | | 协议标志（长度分隔） |
| 48155 | `callUnknownType` | uint32 | | 未知类型标志。观测到 0 / 1 / 2 或缺失 |
| 48156 | `callFlag48156` | uint32 | | 协议标志 |

> ⚠️ `48152` 的单位是**毫秒**，与语音元素的 `45906`（秒）不同。

## 二、`callMethod`（48154）

| 值 | 名称 | 说明 |
| -- | ---- | ---- |
| 1 | VOICE | 语音通话 |
| 2 | VIDEO | 视频通话 |
| 3 | SCREEN_SHARE | 屏幕共享 |
| 5 | REMOTE_ASSIST | 远程协助 |

## 三、`subType` / `answerType`

`45003 (subType)` 与 `48151 (answerType)` 取值一致，合起来描述「什么类型的通话、以什么方式结束」：

| 值 | 名称 | 说明 |
| -- | ---- | ---- |
| 2 | VIDEO_ACCEPTED | 视频通话已接通 |
| 3 | VIDEO_REJECTED_BY_US | 视频通话被本方拒绝 |
| 6 | VIDEO_REJECTED_BY_PEER | 视频通话被对方拒绝 |
| 7 | VOICE_ACCEPTED | 语音通话已接通 |
| 8 | VOICE_REJECTED_BY_US | 语音通话被本方拒绝 |
| 11 | VOICE_REJECTED_BY_PEER | 语音通话被对方拒绝 |
| 12 | VIDEO_HANDLED_OTHER_DEVICE | 视频通话已在其它设备处理 |
| 13 | VOICE_HANDLED_OTHER_DEVICE | 语音通话已在其它设备处理 |
| 19 | SCREEN_SHARE_ACCEPTED | 屏幕共享已接通 |
| 22 | SCREEN_SHARE_REJECTED | 屏幕共享被拒绝 |
| 33 | REMOTE_ASSIST_ACCEPTED | 远程协助已接通 |
| 34 | REMOTE_ASSIST_FAILED | 远程协助失败 |

---

[← 返回消息段索引](../index.md#消息段element索引)
