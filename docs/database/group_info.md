# group_info.db — 群资料

`group_info.db` 是**群聊的资料库**：群名/群主/成员列表/群头衔/精华消息/群通知全在这里。
`nt_msg.db` 只冗余了会话行那一层的展示信息（见
[recent-contact](./nt_msg/recent-contact.md) 的「冗余快照」），群的完整资料得来这边查。

对应 WeQ 解析实现：

| 文件 | 职责 |
| ---- | ---- |
| `packages/db/src/group_info/detail.ts` | `group_detail_info_ver1` → `GroupDetail` |
| `packages/db/src/group_info/member.ts` | `group_member3` → `GroupMember` |
| `packages/db/src/group_info/member_level.ts` | `group_member_level_info` → 等级配置 |
| `packages/db/src/group_info/bulletin.ts` | `group_bulletin` → `GroupBulletin` |
| `packages/db/src/group_info/essence.ts` | `group_essence` → `GroupEssence` |
| `packages/db/src/group_info/ext.ts` | `group_ext_list` → `GroupExt` |
| `packages/db/src/group_info/notify.ts` | `group_notify_list` / `doubt_group_notify_list` → `GroupNotify` |

所有表都以 **`60001`（群号 groupCode）** 为关联键。

---

## 一、`group_detail_info_ver1` — 群详情

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 60001 | `groupCode` | INTEGER | 群号 | 已验证 |
| 60007 | `groupName` | TEXT | 群名 | 已验证 |
| 60216 | `pinnedAnnounce` | TEXT | 置顶公告 | 已验证 |
| 60217 | `description` | TEXT | 群简介 | 已验证 |
| 60026 | `remark` | TEXT | 我给群的备注 | 已验证 |
| 60002 | `ownerUid` | TEXT | 群主 uid（join `group_member3.1000`） | 已验证 |
| 60004 | `createTime` | INTEGER | 建群时间 | 观测一致 |
| 60005 | `maxMemberCount` | INTEGER | 群人数上限 | 已验证 |
| 60006 | `memberCount` | INTEGER | 当前群人数 | 已验证 |
| 60218 | `labels` | TEXT | 群标签 | 观测一致 |
| 60224 | `entranceQ` | TEXT | 入群问题 | 观测一致 |
| 60340 | `leaveFlag` | INTEGER | `0` = 在群，`1` = 已退群 | 观测一致 |
| 60241 | `customLabels` | BLOB | protobuf，自定义头衔列表（标签 id / 内容 / 设置人/时间） | 观测一致 |
| 60242 | `address` | BLOB | protobuf，群地址（经纬度 / 地点名 / 设置人/时间） | 观测一致 |

## 二、`group_member3` — 群成员

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 60001 | `groupCode` | INTEGER | 群号 | 已验证 |
| 1000 | `uid` | TEXT | 成员 uid | 已验证 |
| 1002 | `uin` | INTEGER | 成员 QQ 号 | 已验证 |
| 64003 | `card` | TEXT | **群名片**（群内专属昵称） | 已验证 |
| 20002 | `nick` | TEXT | 全局昵称 | 已验证 |
| 64007 | `joinTime` | INTEGER | 入群时间 | 已验证 |
| 64008 | `lastSpeakTime` | INTEGER | 最后发言时间 | 已验证 |
| 64009 | `muteUntil` | INTEGER | 禁言截止时间（unix 秒） | 已验证 |
| 64010 | `adminFlag` | INTEGER | `0` = 普通成员，`1` = 管理员 | 已验证 |
| 64016 | `memberFlag` | INTEGER | `0`/`NULL` = 在群，`1` = 已退群 | 已验证 |
| 64023 | `customTitle` | TEXT | 专属头衔 | 已验证 |
| 64035 | `memberLevel` | INTEGER | 等级数值 | 已验证 |

成员列表的排序约定（`listMembersInGroup`）：**群主最前**（`uid = group_detail_info_ver1.60002`
置顶）、其次管理员（`64010 DESC`）、再按入群时间升序 —— 与 QQ 群成员页的顺序一致。
查询默认过滤 `64016 = 0 OR NULL`，只列在群成员。

显示名取 `card || nick`（群名片优先，与 QQ 一致）。

## 三、`group_member_level_info` — 等级配置

| 列 | 字段名 | 类型 | 含义 |
| -- | ------ | ---- | ---- |
| 60001 | `groupCode` | INTEGER | 群号 |
| 67100 | `memberLevel` | INTEGER | 等级数值（语义待确认） |
| 67103 | `levelConfig` | BLOB | protobuf：等级 → 头衔名映射（如「 LV1 潜水」） |

群成员头上那串「活跃头衔」文本来自 `67103`；`member.ts` 的 `64035` 数值对回这份配置
才能显示成文字。

## 四、`group_bulletin` — 群公告

| 列 | 字段名 | 类型 | 含义 |
| -- | ------ | ---- | ---- |
| 60001 | `groupCode` | INTEGER | 群号 |
| 64205 | `content` | BLOB | protobuf 公告正文 |

`64205` 的嵌套路径（`bulletin.ts`）：`root → body(64205) → detail(64202)
→ contentContainer(64227) → items(64242, repeated) → textContent(64452)`。
多条 item 的文本以换行拼接。发布人 uid、公告 fid、发布时间都在 detail 里。

## 五、`group_essence` — 精华消息

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 60001 | `groupCode` | INTEGER | 群号 | 已验证 |
| 67501 | `msgSeq` | INTEGER | 被设精消息的 seq，回指消息表 | 已验证 |
| 67502 | `msgRandom` | INTEGER | 该消息的 random | 观测一致 |
| 67503 | `senderUin` | INTEGER | 原发送者 QQ 号 | 已验证 |
| 67504 | `senderNick` | TEXT | 原发送者昵称 | 已验证 |
| 67505 | `setStatus` | INTEGER | **`1` = 当前是精华，`2` = 已被取消** | 已验证 |
| 67506 | `operatorUin` | INTEGER | 设精/取消的操作人 QQ 号 | 已验证 |
| 67507 | `operatorNick` | TEXT | 操作人昵称 | 已验证 |
| 67508 | `timestamp` | INTEGER | 操作时间 | 已验证 |

注意：**取消精华的行不删**，只把 `67505` 改成 `2`。所以「当前精华列表」必须
按 `67505 = 1` 过滤（`listEssenceSeqs` 就是这么做的，给聊天窗口打精华角标用）。

## 六、`group_ext_list` — 群扩展信息

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 60001 | `groupCode` | INTEGER | 群号，主键 | 已验证 |
| 66720 | `activityScore` | INTEGER | 群活跃度分值 | 观测一致 |
| 66721 | `luckyCharId` | INTEGER | 幸运字符 id（0 = 无） | 观测一致 |
| 66722 | `luckyCharLitCount` | INTEGER | 幸运字符点亮个数 | 观测一致 |
| 66723 | `luckyCharContent` | TEXT | 幸运字符文本（如 `yyds`） | 观测一致 |
| 66726 | `periodMsgCount` | INTEGER | 周期内消息量（0 = 无统计） | 观测一致 |
| 66730 | `hasActivity` | INTEGER | 布尔：群近期是否有活动 | 观测一致 |
| 66731 | `activityRecordId` | INTEGER | 活动 64 位 id（0 = 无） | 观测一致 |
| 66732 | `ownerInfo` | BLOB | protobuf：群主 uid + uin（detail 表只有 uid，**uin 在这里**） | 观测一致 |
| 66733 | `hasSpecialMark` | INTEGER | 布尔标志，含义待确认 | 推测 |

## 七、`group_notify_list` / `doubt_group_notify_list` — 群通知

入群申请、踢人、设管等通知事件。两张表**列布局相同**，
`doubt_` 那张存「疑似相关」的通知（WeQ 分开读取，来源标记在 `sourceTable`）。

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 61001 | `msgTime` | INTEGER | 通知时间，**毫秒**（读时除以 1000 转秒） | 已验证 |
| 61002 | `status` | INTEGER | 事件类型，见下 | 已验证 |
| 61003 | `verifyStatus` | INTEGER | 处理状态：`0` 无需处理 / `1` 待处理 / `2` 已同意 / `3` 已拒绝 | 已验证 |
| 61004 | `groupInfo` | BLOB | protobuf：群号 + 群名 | 已验证 |
| 61005 | `operatedUser` | BLOB | protobuf：被操作者 uid + 昵称（QQ 号列里没有，service 层查 profile 库补） | 已验证 |
| 61006 | — | BLOB | **实测恒为 null**，操作人真身在 61007 | 已验证 |
| 61007 | `operatorUser` | BLOB | protobuf：操作发起人 uid + 昵称（先 61007 后 61006 兜底） | 已验证 |
| 61008 | `opTime` | INTEGER | 操作时间（秒） | 观测一致 |
| 61010 | `remark` | TEXT | 申请留言 | 观测一致 |
| 61011 | `systemRemark` | TEXT | 系统附言 | 观测一致 |

`61002` 的枚举（`GroupNotifyStatus`）：

| 值 | 含义 |
| -- | ---- |
| 1 | 申请入群 |
| 3 | 被设为管理员 |
| 6 | 被踢出 |
| 11 | 申请被拒绝 |
| 13 | 退群 |
| 15 | 被撤销管理员 |

---

[← 返回数据库分析](./index.md)
