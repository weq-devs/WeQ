# elementType 8 — 灰字提示

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 8`）。

「小灰条」是聊天中居中显示的那一行灰色提示：撤回、拍一拍、入群、禁言、临时会话……
它们**共用一个 elementType**，靠 `45003 (subType)` 再分一次类，
而不同 subType 使用的 tag 段**几乎不重叠**——实际上是六种完全不同的结构挤在同一个类型下。

---

## 一、subType 全表

名字取自 QQ NT 的 `NTGrayTipElementSubTypeV2` 枚举。
目前只观测到 1 / 4 / 10 / 12 / 15 / 17；其余声明出来只为将来遇到时有名字可对。

| 值 | 名称 | WeQ 的 kind | 说明 | tag 段 |
| -- | ---- | ----------- | ---- | ------ |
| 0 | UNKNOWN | — | 占位（未观测） | — |
| 1 | REVOKE | `grayTipRevoke` | **撤回提示**（「XX 撤回了一条消息」） | `477xx` |
| 2 | PROCLAMATION | — | 群公告（未观测） | — |
| 3 | EMOJI_REPLY | — | 表情回应（未观测） | — |
| 4 | GROUP_TIP | `grayTipGroup` | **群通知**：入群 / 退群 / 禁言 / 改群名 | `485xx` |
| 5 | BUDDY | — | 好友相关提示（未观测） | — |
| 6 | FEED | — | 动态 Feed 提示（未观测） | — |
| 7 | ESSENCE | — | 设为精华消息（未观测） | — |
| 8 | GROUP_NOTIFY | — | 群通知（系统下发，未观测） | — |
| 9 | BUDDY_NOTIFY | — | 好友通知（系统下发，未观测） | — |
| 10 | FILE | `grayTipFileRecv` | **文件传输完成灰条**（接收或上传成功） | 文件族 `454xx/455xx` |
| 11 | FEED_CHANNEL_MSG | — | 频道消息 Feed（未观测） | — |
| 12 | XML_MSG | `grayTipInvite` | **XML 灰条**（通用 XML 消息） | `482xx` |
| 13 | LOCAL_MSG | — | 本地消息，仅本端可见（未观测） | — |
| 14 | BLOCK | — | 拉黑相关（未观测） | — |
| 15 | AIO_OP | `grayTipTempSession` | **临时会话提示** | `475xx` |
| 16 | WALLET | — | 钱包相关（未观测） | — |
| 17 | JSON | `grayTipPoke` | **JSON 灰条**：拍一拍、互动标识 | `482xx` |

> 历史上 subType=12 曾被 WeQ 当作「邀请」处理，故 kind 名叫 `grayTipInvite`；
> 实际它是通用的 XML 灰条。

---

## 二、subType=1 — 撤回

| tag | 字段名 | 类型 | 必有 | 含义 |
| --- | ------ | ---- | ---- | ---- |
| 47702 | `recallFlag47702` | uint32 | ✅ | 未知整数 |
| 47703 | `recallRevokeUid` | string | ✅ | **撤回操作者** uid |
| 47704 | `recallSenderUid` | string | ✅ | **被撤回消息发送者** uid |
| 47705 | `recallSenderNick` | string | ✅ | 被撤回者昵称 |
| 47713 | `recallDisplayText` | string | ✅ | 撤回展示文案 |
| 47714 | `recallRevokeNick` | string | ✅ | 撤回者昵称 |
| 47710 | `recallElements` | repeated `ReplyElementWire` | | 被撤回消息的原始 element 副本。**只在撤回自己的消息时才有** |
| 47711 | `recallFlag47711` | uint32 | | 未知整数 |
| 47712 | `recallFlag47712` | uint32 | | 两条观测行均为 1 |

### 六个昵称字段的关系

`47706/47715` 是昵称副本，`47707/47716` 装的是**群名片**。这一点在一次群撤回上得到验证：
该用户昵称为「🍬🐱帕罗丁，然后8年之誓」，而群名片是「期中考试加油」，两者确实不同。

QQ 会**同时写一份「被撤回者」副本和一份「撤回者」副本**，即使两者是同一个人。
所以自己撤回自己的消息时，这六个字段值全部一致。

| tag | 字段名 | 归属 | 含义 |
| --- | ------ | ---- | ---- |
| 47705 | `recallSenderNick` | 被撤回者 | 昵称 |
| 47706 | `recallSenderNickCopy` | 被撤回者 | 昵称副本（同 47705） |
| 47707 | `recallSenderGroupNick` | 被撤回者 | **群名片**（群里与昵称不同） |
| 47714 | `recallRevokeNick` | 撤回者 | 昵称 |
| 47715 | `recallRevokeNickCopy` | 撤回者 | 昵称副本（同 47714） |
| 47716 | `recallRevokeGroupNick` | 撤回者 | **群名片** |

---

## 三、subType=4 — 群通知

| tag | 字段名 | 类型 | 必有 | 含义 |
| --- | ------ | ---- | ---- | ---- |
| 48501 | `groupTipType` | uint32 | ✅ | 事件类型，见下表 |
| 48503 | `user1Uid` | string | | 用户 1 uid |
| 48504 | `user1Nick` | string | | 用户 1 昵称 |
| 48505 | `user1GroupNick` | string | | 用户 1 群名片 |
| 48506 | `user2Uid` | string | | 用户 2 uid |
| 48507 | `user2Nick` | string | | 用户 2 昵称 |
| 48508 | `user2GroupNick` | string | | 用户 2 群名片 |
| 48509 | `groupTipGroupName` | string | | **群名称** —— 出现在「XX 邀请你加入 &lt;群名&gt;」这类提示上（该群不是当前会话） |
| 48541 | `muteInfo` | message | | 禁言详情，见下 |
| 48542 | `grayTipTimestamp` | uint32 | | 提示时间戳，unix 秒。约 9700 个不同取值，均与消息自身发送时间一致 |

### `groupTipType`（48501）

名字取自 QQ NT 的 `TipGroupElementType` 枚举。本地库里出现过 1/2/3/5/8。

| 值 | 名称 | 说明 |
| -- | ---- | ---- |
| 0 | KUNKNOWN | 占位（未观测） |
| 1 | KMEMBERADD | **成员入群**：user1 是新成员，user2 是邀请人（无邀请人时 QQ 只写 user1） |
| 2 | KDISBANDED | 群已解散 |
| 3 | KQUITTE | **成员被移出群聊**：user1Nick 是操作者昵称，user2Uid 是被移出者 |
| 4 | KCREATED | 群创建成功（未观测） |
| 5 | KGROUPNAMEMODIFIED | **群名被修改**：user1 是操作者，`groupTipGroupName` 是新群名 |
| 6 | KBLOCK | 成员被拉黑（未观测） |
| 7 | KUNBLOCK | 成员被移出黑名单（未观测） |
| 8 | KSHUTUP | **禁言**：详情在 `muteInfo`，时长为 0 表示解除禁言 |
| 9 | KBERECYCLED | 群因违规被回收（未观测） |
| 10 | KDISBANDORBERECYCLED | 群被解散或被回收（未观测） |

### `muteInfo`（48541）

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 48521 | `operator` | message | 操作者，内含 `1000: uid` |
| 48522 | `mutedUser` | message | 被禁言者，内含 `1000: uid`、`20002: groupNick` |
| 48531 | `timestamp` | uint64 | 时间戳 |
| 48532 | `duration` | uint32 | **禁言时长（秒）**，0 = 解除 |

### 未验证

| tag | 字段名 | 观测情况 |
| --- | ------ | -------- |
| 48502 | `groupTipFlag48502` | 取值 0/1/2 |
| 48510 | `groupTipFlag48510` | 只要出现就恒为 1 |
| 48511 | `groupTipFlag48511` | 取值 0（×2874）/ 2 / 1 / 3 |

---

## 四、subType=10 — 文件传输完成

结构上是一个**披着 elementType=8 外壳的 FILE element**：它复用 `454xx/455xx` 文件族 tag，
一个灰条专属字段都没有。QQ 把它作为一条独立的行，写在真正的 FILE 消息旁边。

它表示一次文件传输已完成——既可能是**收到对方发来的文件**，也可能是**自己上传成功**，
灰条本身不带方向标记，所以 WeQ 统一渲染为中性文案「文件传输完成」。
行级 msgType 为 `40011=5 / 40012=1`（系统提示）或 `40011=1 / 40012=2`。

| tag | 字段名 | 类型 | 必有 |
| --- | ------ | ---- | ---- |
| 45402 | `fileName` | string | ✅ |
| 45405 | `fileSize` | uint32 | ✅ |
| 45407 | `md5Bytes2` | bytes | |
| 45503 | `fileToken` | string | |
| 45411 / 45412 | `imgWidth` / `imgHeight` | uint32 | |
| 45410 | `videoDuration` | uint32 | |

> `fileName` 在 wire 上出现了两次，WeQ 取第一个。

---

## 五、subType=15 — 临时会话

QQ 渲染为「该用户通过 xxx 群聊向你发起临时会话」。
恒为一个 C2C 会话的**首条消息**（seq=1），且该行本身不带发送者（`40020` 为空）。

| tag | 字段名 | 类型 | 必有 | 含义 |
| --- | ------ | ---- | ---- | ---- |
| 47502 | `tempSessionGroupCode` | string | ✅ | **发起临时会话的来源群号**（十进制字符串） |
| 47501 | `aioOpFlag47501` | uint32 | | 恒为 1，疑似提示变体标识 |
| 40021 | `origReceiverUid` | string | | 行级对端 uid 的冗余副本 |

> `47502` 已验证确实是群号而非对方 QQ 号：所有观测值在 `group_msg_table` 里都有真实群聊记录，
> 且没有一个与对端自身 uin 相同。

---

## 六、subType=17（JSON）与 subType=12（XML）

这两者共用 `482xx` 段。subType=17 是拍一拍、互动标识（畅聊之火 / 初泛涟漪）等；
subType=12 是通用 XML 灰条。

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 48210 | `actionInitiator` | message | **动作发起者**，内含 `1005: uid`、`1006: nickname` |
| 43210 | `actionTarget` | message | **动作目标**，结构同上 |
| 48211 | `actionId` | uint32 | 动作类型 id。观测到 12（拍一拍）、16（红包） |
| 48212 | `detailedId` | uint32 | 详细动作 id。1=系统，1061=拍一拍，19357=红包 |
| 48213 | `typeFlag` | uint32 | 类型标志。观测到 7 |
| 48214 | `grayTipXmlContent` | string | **XML 预览文档** |
| 48215 | `businessId` | uint32 | **业务 id**，见下方 `JsonGrayBusiId` 全表。观测到 1132 |
| 48216 | `actionUniqueId` | uint32 | 本次动作的唯一 id |
| 48217 | `actionAttributes` | repeated message | 附加属性，每项 `{1005: key, 1006: value}` |
| 48271 | `tipJson` | string | **提示的 JSON 负载**（subType=17 必有） |
| 48273 | `tipType` | uint32 | 提示类型，1=系统，与 `detailedId` 对应 |
| 48274 | `grayTipPlainText` | string | **互动标识提示原文**，如「你和XX互发消息连续超过7天，已获得畅聊之火标识」。`tipJson` 的纯文本版 |
| 48542 | `grayTipTimestamp` | uint32 | 提示时间戳 |

### `tipJson`（48271）的形状

```jsonc
{
  "items": [
    { "type": "nor", "txt": "文本片段" },
    { "type": "qq",  "uid": "u_xxx", "col": "#ff0000", "jp": "跳转协议" },
    { "type": "img", "src": "图片地址" },
    { "type": "url", "txt": "链接文字", "jp": "跳转地址" }
  ]
}
```

`type` 已知 `img` / `qq` / `nor` / `url` 四种；`jp` 是点击跳转协议。

### `grayTipXmlContent`（48214）的形状

```xml
<gtip align="...">
  <qq uin="..." col="..." nm="..." tp="..."/>
  <img src="..." />
  <nor txt="..." />
</gtip>
```

### 未验证

| tag | 字段名 | 观测情况 |
| --- | ------ | -------- |
| 48218 | `grayTipReserved` | 保留字段（string） |
| 48219 | `grayTipFlag48219` | 取值 0（×49）/ 1（×1） |
| 48220 | `grayTipFlag48220` | 取值 0（×59）/ 64（×1） |
| 48272 | `grayTipFlag48272` | 观测为 true |
| 48275 | `grayTipFlag48275` | uint32，语义未知 |

---

## 七、`businessId`（48215）全表

取值来自 QQ NT 自身的 `JsonGrayBusiId` 枚举 —— 它标识这条 JSON 灰条**由哪个业务下发**，
决定了 `tipJson` 里的文案与跳转协议属于什么场景。本地样本只覆盖到其中极少数（如 1132），
这里完整列出以便遇到时能直接对号入座。

> ⚠️ 枚举仅记录在此文档，未进代码：解析层不依赖它，`48215` 照旧按裸数字解析。
> 取值命名保留 QQ 原样。

### 在线文件传输（1..13）

| 值 | 名称 | 含义 |
| -- | ---- | ---- |
| 1 | ONLINE_FILE_STOP_SEND | 停止发送 |
| 2 | ONLINE_FILE_STOP_SEND_ON_SENDING | 发送中停止发送 |
| 3 | ONLINE_FILE_REFUSE_RECV | 拒绝接收 |
| 4 | ONLINE_FILE_CANCEL_RECV_ON_RECVING | 接收中取消接收 |
| 5 | ONLINE_FILE_STOP_ALL_SEND | 停止全部发送 |
| 6 | ONLINE_FILE_STOP_ALL_SEND_ON_SENDING | 发送中停止全部发送 |
| 7 | ONLINE_FILE_REFUSE_ALL_RECV | 拒绝接收全部 |
| 8 | ONLINE_FILE_REFUSE_ALL_RECV_ON_RECVING | 接收中拒绝接收全部 |
| 9 | ONLINE_FILE_SEND_ERROR | 发送出错 |
| 10 | ONLINE_FILE_RECV_ERROR | 接收出错 |
| 11 | ONLINE_FILE_GO_OFFLINE | 离线 |
| 12 | ONLINE_FILE_GO_OFFLINE_ALL | 全部离线 |
| 13 | ONLINE_FILE_RECV_BY_MOBILE | 已由手机接收 |

### 杂项

| 值 | 名称 | 含义 |
| -- | ---- | ---- |
| 51 | ONLINE_GROUP_HOME_WORK | 群作业 |
| 81 | RED_BAG | 红包 |
| 86 | LITE_ACTION | 轻量动作 |

### 关系链（1000..1022）

| 值 | 名称 | 含义 |
| -- | ---- | ---- |
| 1000 | RELATION_CHAIN_BLACKED | 被拉黑 |
| 1001 | RELATION_EMOJIEGG_SHOW | 表情彩蛋展示 |
| 1002 | RELATION_EMOJIEGG_WILL_DEGRADE | 表情彩蛋即将降级 |
| 1003 | RELATION_C2C_LOVER_BONUS | 情侣加成 |
| 1004 | RELATION_C2C_SAY_HELLO | 打招呼 |
| 1005 | RELATION_C2C_GROUP_AIO_SETUP_GROUP_AND_REMARK | 设置分组与备注 |
| 1006 | RELATION_FRIEND_CLONE_INFO | 好友克隆信息 |
| 1007 | RELATION_CHAIN_MATCH_FRIEND | 匹配好友 |
| 1008 | RELATION_NEARBY_GOTO_VERIFY | 附近的人去验证 |
| 1009 | RELATION_CREATE_GROUP_GRAY_TIP_ID | 创建群聊 |
| 1010 | RELATION_YQT | 一起听 |
| 1011 | RELATION_LIMIT_TMP_CONVERSATION_SET | 临时会话限制设置 |
| 1012 | RELATION_ONEWAY_FRIEND_GRAY_TIP_ID | 单向好友 |
| 1013 | RELATION_ONEWAY_FRIEND_NEW_GRAY_TIP_ID | 单向好友（新） |
| 1014 | RELATION_GROUP_SHUT_UP | 群禁言 |
| 1015 | RELATION_GROUP_MEMBER_ADD_WITH_MODIFY_NAME | 加群成员并改名 |
| 1016 | RELATION_GROUP_MEMBER_ADD_WITH_WELCOME | 加群成员并欢迎 |
| 1017 | RELATION_C2C_MEMBER_ADD | 添加好友 |
| 1018 | RELATION_C2C_REACTIVE_UPGRADE_MSG | 亲密度升级 |
| 1019 | RELATION_C2C_REACTIVE_DEGRADE_MSG | 亲密度降级 |
| 1020 | RELATION_GROUP_BATCH_ADD_FRIEND | 群内批量加好友 |
| 1021 | RELATION_GROUP_MEMBER_RECOMMEND | 群成员推荐 |
| 1022 | RELATION_GROUP_MEMBER_ADD | 加群成员 |

### AIO 会话内提示（2000..2100）

| 值 | 名称 | 含义 |
| -- | ---- | ---- |
| 2000 | AIO_RECALL_MSGCUSTOM_WORDINGGUIDE | 撤回自定义文案引导 |
| 2021 | AIO_AV_C2C_NOTICE | 私聊音视频通知 |
| 2022 | AIO_AV_GROUP_NOTICE | 群音视频通知 |
| 2041 | AIO_NUDGE_CUSTOM_GUIDE | 拍一拍自定义引导 |
| 2050 | AIO_CRM_FLAGS_TIPS | CRM 标识提示 |
| 2060 | PTT_AUTO_CHANGE_GUIDE | 语音自动变声引导 |
| 2100 | AIO_C2C_DONT_DISTURB | 私聊免打扰 |

### Z-Plan / 机器人 / 推送（2201..2701）

| 值 | 名称 | 含义 |
| -- | ---- | ---- |
| 2201 | AIO_ROBOT_SAFETY_TIP | 机器人安全提示 |
| 2300 | AIO_ZPLAN_SEND_MEME | Z-Plan 发送梗图 |
| 2301 | AIO_ZPLAN_EMOTICON_GUIDE | Z-Plan 表情引导 |
| 2302 | AIO_ZPLAN_SCENE_LINKAGE | Z-Plan 场景联动 |
| 2601 | QCIRCLE_SHOW_FULE_TIPS | 小世界提示 |
| 2602 | QWALLET_GRAY_TIP_ID | QQ 钱包 |
| 2603 | DISBAND_DISCUSSION_GRAY_TIP_ID | 解散讨论组 |
| 2701 | AIO_PUSH_GUIDE_GRAY_TIPS | 推送引导 |

### 群会话（2401..2408）

| 值 | 名称 | 含义 |
| -- | ---- | ---- |
| 2401 | AIO_GROUP_ESSENCE_MSG_TIP | 群精华消息 |
| 2402 | GROUP_AIO_SHUTUP_GRAY_TIP_ID | 群禁言 |
| 2403 | GROUP_AIO_UPLOAD_PERMISSIONS_GRAY_TIP_ID | 群上传权限 |
| 2404 | GROUP_AIO_HOME_SCHOOL_WELCOME_GRAY_TIP_ID | 家校群欢迎 |
| 2405 | GROUP_AIO_TEMPORARY_GRAY_TIP_ID | 群临时会话 |
| 2406 | GROUP_AIO_MSG_FREQUENCY_GRAY_TIP_ID | 群消息频率 |
| 2407 | GROUP_AIO_CONFIGURABLE_GRAY_TIPS | 群可配置灰条 |
| 2408 | GROUP_AIO_UNREAD_MSG_AI_SUMMARY | 群未读消息 AI 总结 |

### 文件大小限制（3001..3003）

| 值 | 名称 | 含义 |
| -- | ---- | ---- |
| 3001 | VAS_FILE_UPLOAD_OVER_LIMIT | 上传超出限制 |
| 3002 | VAS_FILE_UPLOAD_OVER_1G | 上传超过 1G |
| 3003 | FILE_SENDING_SIZE_4GB_LIMIT | 发送 4GB 限制 |

### 群加好友 / 破冰（10405, 19264..19273）

| 值 | 名称 | 含义 |
| -- | ---- | ---- |
| 10405 | TROOP_BREAK_ICE | 群破冰 |
| 19264 | TROOP_ADD_FRIEND_ACTIVE | 加好友：活跃成员 |
| 19265 | TROOP_ADD_FRIEND_HOT_CHAT | 加好友：热聊 |
| 19266 | TROOP_ADD_FRIEND_REPLY_OR_AT | 加好友：回复或 @ |
| 19267 | TROOP_ADD_FRIEND_NEW_MEMBER | 加好友：新成员 |
| 19273 | TROOP_FLAME_IGNITED | 群火花点燃 |

### 预留

| 值 | 名称 | 含义 |
| -- | ---- | ---- |
| 100000 | UI_RESERVE_100000_110000 | UI 预留区间起点（100000–110000） |

> 💡 WeQ 的[防撤回](../../../guide/anti-recall.md)功能正是构造一条 subType=17 的自定义灰条
> 来记录被拦截的撤回事件。

---

[← 返回消息段索引](../index.md#消息段element索引)
