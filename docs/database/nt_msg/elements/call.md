# elementType 21 — 通话记录

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 21`）。
枚举定义：`packages/codec/src/element/types.ts`（`CallType` / `CallSubType`）。

音视频通话记录（QQ 内部名 AVRECORD）：语音通话、视频通话、屏幕共享、远程协助的结果条目。

> ⚠️ **私聊与群聊是两套结构**，`subType` 的编号也不互通，详见第四节。

---

## 一、字段

| tag | 字段名 | 类型 | 必有 | 含义 |
| --- | ------ | ---- | ---- | ---- |
| 48151 | `answerType` | uint32 | ✅ | 接听 / 挂断类型，与 `subType` 一致，取值见 `CallSubType` |
| 48152 | `duration` | uint32 | ✅ | **通话时长（毫秒）**，但旧版客户端写的是时间戳，见下方说明 |
| 48154 | `callMethod` | uint32 | ✅ | **通话方式**，见下表 |
| 48157 | `callSummary` | string（repeated） | ✅ | 通话摘要文案 |
| 48153 | `callFlag48153` | string | | 协议标志（长度分隔）。实测恒等于 `callSummary` 去掉前缀后的正文 |
| 48155 | `callUnknownType` | uint32 | | 未知类型标志。观测到 0 / 1 / 2 或缺失 |
| 48156 | `callFlag48156` | uint32 | | 协议标志。可当作**客户端世代标记**：旧版写 0，新版写 1 |

> ⚠️ `48152` 的单位是**毫秒**，与语音元素的 `45906`（秒）不同。

### `duration` 的世代差异（坑）

2025 年前后 QQ 重构过通话模块，`48152` 的语义跟着变了：

| 世代 | `callFlag48156` | `duration` 实际内容 | `callSummary` 形态 |
| ---- | --------------- | ------------------- | ------------------ |
| 旧版 | `0` | **unix 秒级时间戳**（如 `1726891067`） | 带方式前缀：`[语音通话] 通话时长 00:35` |
| 新版 | `1` | 毫秒时长（如 `1001` = 00:01） | 无前缀：`通话时长 00:01` |

所以**不要直接拿 `duration` 格式化时长** —— 旧记录会算出荒谬的值。渲染一律优先用
QQ 已经排好版的 `callSummary`（WeQ 的 `QqCall` 就是这么做的）。

## 二、`callMethod`（48154）

| 值 | 名称 | 说明 |
| -- | ---- | ---- |
| 0 | GROUP_ENDED | **群聊**「通话已结束」提示，无方式字段；具体是语音还是视频只能看 `subType` |
| 1 | VOICE | 语音通话 |
| 2 | VIDEO | 视频通话 |
| 3 | SCREEN_SHARE | 屏幕共享 |
| 5 | REMOTE_ASSIST | 远程协助 |

## 三、`subType` / `answerType`

`45003 (subType)`、`48151 (answerType)` 与消息行的 `40012` 列三者取值一致，合起来
描述「什么类型的通话、以什么方式结束」。

### 私聊（c2c_msg_table）

一条消息 = 一整通电话的**最终状态**，中间过程不落库。

| 值 | 名称 | 摘要文案 | 说明 |
| -- | ---- | -------- | ---- |
| 2 | VIDEO_ACCEPTED | 通话时长 xx:xx | 视频通话已接通 |
| 3 | VIDEO_REJECTED_BY_US | 未接听，点击回拨 | 视频通话被本方拒绝 |
| 5 | VIDEO_ACCEPTED_LEGACY | [视频通话] 通话时长 xx:xx | 视频接通，**旧版客户端编号**，语义同 2 |
| 6 | VIDEO_REJECTED_BY_PEER | 对方已拒绝 | 视频通话被对方拒绝 |
| 7 | VOICE_ACCEPTED | 通话时长 xx:xx | 语音通话已接通 |
| 8 | VOICE_REJECTED_BY_US | 未接听，点击回拨 | 语音通话被本方拒绝 |
| 9 | VOICE_PEER_NO_ANSWER | 对方未接听 | 我方拨出、对方一直没接（**旧版客户端**） |
| 10 | VOICE_CANCELED_BY_US | 已取消，点击重拨 | 我方拨出后自己取消 |
| 11 | VOICE_REJECTED_BY_PEER | 对方已拒绝 | 语音通话被对方拒绝 |
| 12 | VIDEO_HANDLED_OTHER_DEVICE | 已在其他设备处理 | 视频通话已在其它设备处理 |
| 13 | VOICE_HANDLED_OTHER_DEVICE | 已在其他设备处理 | 语音通话已在其它设备处理 |
| 19 | SCREEN_SHARE_ACCEPTED | 通话时长 xx:xx | 屏幕共享已接通 |
| 22 | SCREEN_SHARE_REJECTED | 对方未接听 | 屏幕共享被拒绝 |
| 33 | REMOTE_ASSIST_ACCEPTED | 远程协助时长 xx:xx | 远程协助已接通 |
| 34 | REMOTE_ASSIST_FAILED | 已取消，点击重新发起 | 远程协助失败 |

> 5 / 9 是旧版客户端才写的编号（`callFlag48156 = 0`），2025 年后的记录不再出现。
> 保留是为了历史消息能正确渲染。

### 群聊（group_msg_table）

**拆成两条独立消息**，中间状态（谁加入、谁离开、通了多久）一概不落库：

| 值 | 名称 | `callMethod` | 40020（发送者） | 摘要文案 |
| -- | ---- | ------------ | --------------- | -------- |
| 1 | GROUP_VOICE_STARTED | 1 (VOICE) | 发起人 uid | 发起了语音通话 |
| 26 | GROUP_VIDEO_STARTED | 2 (VIDEO) | 发起人 uid | 发起了视频通话 |
| 16 | GROUP_VOICE_ENDED | **0** | **空** | 语音通话已结束 |
| 25 | GROUP_VIDEO_ENDED | **0** | **空** | 视频通话已结束 |

结束那条的 `40020` / `40033` 都是空的 —— 它不属于任何人，QQ 电脑端也把它画成居中
灰条。另外**只有本机发起的通话才会写「发起」消息**：别人在群里发起时本机只收得到
结束提示，所以历史记录里「结束」往往比「发起」多。

## 四、渲染约定（WeQ）

| 场景 | 组件 | 形态 |
| ---- | ---- | ---- |
| 私聊全部 | `QqCall` | 气泡内联：图标 + `callSummary`，失败/拒绝/未接标红 |
| 群聊「发起」(1/26) | `QqCall` | 同上，气泡带发起人头像与昵称 |
| 群聊「已结束」(16/25) | `GroupCallEndedMessage` | 居中灰条，无发送者 |

分流在 `apps/desktop/src/renderer/src/im-template/template/chatPane.tsx` 的
`grayTipOf()` 里：CALL 元素且 `subType ∈ {16, 25}` 的走灰条 band，其余照常走气泡。

## 五、排查工具

```bash
# 全表扫描，统计 (callMethod, subType) 组合并列出未枚举值的会话与时间
pnpm tsx packages/db/tools/scan_call_types.ts

# 解码指定 msgId 的 CALL 元素（含原始 hex）
pnpm tsx packages/db/tools/dump_call_element.ts <msgId> [<msgId> ...]
```

---

[← 返回消息段索引](../index.md#消息段element索引)
