# 消息行 — c2c / group / dataline 共用的列布局

`c2c_msg_table` / `group_msg_table` / `dataline_msg_table` 三张消息表的**列布局完全一致**，
差别只在会话分区键的语义（见下文第一节）。一行 = 一条消息；列名就是 protobuf 字段号
（SQLite 里是带引号的数字列，如 `"40001"`）。

对应 WeQ 解析实现：

| 文件 | 职责 |
| ---- | ---- |
| `packages/db/src/msg/c2c.ts` | 私聊 / 数据线行的读写（dataline 复用同一个类，只换表名） |
| `packages/db/src/msg/group.ts` | 群聊行的读写（多了 40062 贴表情列） |
| `packages/codec/src/domain/msg/row_to_message.ts` | SQL 行 → 语义 `Message`（枚举映射、protobuf 解码） |
| `packages/codec/src/domain/msg/enums.ts` | `ChatType`（40010）全表 |
| `packages/codec/src/proto/msg/40900.ts` | `MsgType` / `SendType` / `SendStatus` 枚举（同号 tag 也用于 40900 缓存里） |

> 本页只讲**行级列**。行里最复杂的两个 protobuf 列 40800（正文）与 40900（转发/引用缓存）
> 各自成篇：见 [40800](./40800.md) / [40900](./40900.md)；群聊的贴表情列见
> [40062](./40062.md)。

---

## 一、三张表的差别只在分区键

| 表 | 会话分区列 | 分区值 |
| -- | ---------- | ------ |
| `c2c_msg_table` | `40027` | 对端的 sortNo（来自 `nt_uid_mapping_table.48901`，**有索引**） |
| `group_msg_table` | `40027` | 群号（group code，文本形态存储，同样**有索引**） |
| `dataline_msg_table` | `40027` | 数据线对端（我的手机 / 电脑 / 平板），结构同 c2c |

c2c 里 `40021`（对端 uid）虽是应用层的会话键，却**没有索引**——所以快路径必须先
uid → sortNo 翻译一次，再按 `40027` 查（详见 [index.md · nt_uid_mapping_table](./index.md#nt_uid_mapping_table)）。
查不到 uid 映射时才退化为按 `40021` 全扫。

群里则相反：`40027` 就是群号本身，应用层和存储层用同一个键。

## 二、列全表

### 身份与分区

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 40001 | `msgId` | INTEGER (PK) | 消息 id，雪花 id | 已验证 |
| 40002 | `msgRandom` | INTEGER | 消息随机数。与 40003 组成 `UNIQUE(40027,40003,40002)`；WeQ 用它当防撤回 trigger 的「允许修改」信号（见下文第五节） | 已验证 |
| 40003 | `msgSeq` | INTEGER | 会话内递增序号。**不是全序**：灰条与它挂靠的消息共用同一 seq，排序需 `(40003, 40050, 40001)` 三键 | 已验证 |
| 40010 | `chatType` | INTEGER | 聊天类型（1 私聊 / 2 群聊 / 8 数据线 / 100+ 临时会话…），全表见 [enums.ts](../../../packages/codec/src/domain/msg/enums.ts) 的 `ChatType` | 已验证 |
| 40011 | `msgType` | INTEGER | 消息大类（2 混排 / 5 灰条 / 8 合并转发 / 9 引用回复…），见 `MsgType` | 已验证 |
| 40012 | `subMsgType` | INTEGER | 子类型，语义跟随 40011。**删除 / 撤回签名的一半**（见第五节） | 已验证 |
| 40013 | `sendType` | INTEGER | 发送来源：0 别人发的 / 1 本机 / 2 本账号其它端 / 5 转发，见 `SendType` | 已验证 |
| 40020 | `senderUid` | TEXT | 发送者 uid。私聊里自己发的行此值 = 本账号 uid（≠ 40021） | 已验证 |
| 40021 | `targetUid` | TEXT | 对端 uid（私聊恒为对端；群聊行为群号体系，此列存群 code） | 已验证 |
| 40027 | 分区键 | TEXT/INTEGER | 见第一节：c2c = sortNo，群 = 群号 | 已验证 |
| 40030 | `targetUin` | INTEGER | 对端 QQ 号 | 观测一致 |
| 40033 | `senderUin` | INTEGER | 发送者 QQ 号 | 已验证 |
| 40035 | `appId` | INTEGER | 数字服务 id；`service_assistant_msg_table` 复用本布局时以它做分区（那边 40020/40021 恒为本账号 uid） | 观测一致 |
| 40040 | `sentSource` | INTEGER | **1 = 本机真实发出**（按下发送键）；0 = 同步副本（含自己转发自己的行）。判「我发的」比 40020 更可靠 | 已验证 |
| 40041 | `sendStatus` | INTEGER | 发送状态：0 被阻止 / 1 未发出 / 2 成功 / 3 被封禁，见 `SendStatus` | 观测一致 |

### 时间

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 40050 | `sendTime` | INTEGER | 发送时间（unix 秒） | 已验证 |
| 40058 | `dayTimestamp` | INTEGER | 当天 0 点的时间戳（unix 秒）。覆盖索引 `(40027,40058)` 让「按年分桶」不必碰正文行 | 观测一致 |

> 排序约定：`40003` 有大量同值（灰条挂靠），稳定排序必须 `(40003, 40050, 40001)`。
> 只按 40003 排会撞上 `UNIQUE` 索引里 40002（随机数）的次序，同 seq 一段是乱的。

### 内容

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 40800 | `msgBody` | BLOB | 消息正文，protobuf `repeated ElementWire`，见 [40800](./40800.md) | 已验证 |
| 40801 | `msgDress` | BLOB | 消息装扮（气泡/字体/挂件），见 [40801](./40801.md) | 观测一致 |
| 40900 | `msgCache` | BLOB | 转发 / 引用时缓存的源消息快照（可递归嵌套），见 [40900](./40900.md) | 已验证 |
| 40062 | `setEmoji` | BLOB | **仅群聊**：贴表情回应，protobuf `repeated EmojiSticker`，见 [40062](./40062.md) | 已验证 |

### 手机→PC 迁移的 seq-less 行

迁移导入的历史消息可能 `40003 = 0 / NULL`（没有会话内序号），但 `40050` 是真实的。
常规的 `40003 > ?` 游标永远看不到它们；按导出需要另开一条 rowid 序的流，与 seq 流按
sendTime 归并（`listSeqlessAfterRowId`）。两流用「seq 是否 > 0」保持不相交，不会重复。

## 三、读消息的典型查询形态

WeQ 的所有会话查询都落在同一组索引上（`40027` 为首列的复合索引）：

```sql
-- 最新一页（命中 (40027,40003) 复合索引）
SELECT … FROM c2c_msg_table
WHERE "40027" = ?        -- sortNo / 群号
ORDER BY "40003" DESC, "40050" DESC, "40001" DESC
LIMIT ?;

-- 新消息监听：rowid 单调递增，与 msgId 顺序无关
SELECT … FROM group_msg_table WHERE rowid > ? ORDER BY rowid ASC LIMIT ?;
```

「我发的」判据按场景二选一：

- 单方向统计（发 / 收）：`40040 = 1` 是 QQ 自证的本机发出标记，连「自己转发别人的消息」
  都能排除；
- 逐行分析（年度报告等）：`40020 != 40021 AND 40020 != ''`（私聊自证），群聊优先
  `senderUid`（40020）匹配、退到 `senderUin`（40033）匹配。

## 四、群聊与私聊的列差异速查

| 差异点 | c2c | group |
| ------ | --- | ----- |
| 40027 语义 | 对端 sortNo（整数） | 群号（文本形态） |
| 40062 贴表情 | 无此列数据 | 有（见 [40062](./40062.md)） |
| 排序 tie-break | 40050, 40001 | 40050, 40001（UNIQUE 索引含 40002，但不可靠不依赖） |
| 40040 语义 | 相同：1 = 本机发出 | 相同 |

## 五、删除 / 撤回签名 `(40011, 40012) = (1, 1)`

QQ 本体撤回或删除一条消息时，**不删行**，而是原地把 `40011`（msgType）和 `40012`
（subMsgType）改写成 `(1, 1)`，40800 正文保持原样——所以「已删除」的消息在数据库里
仍然完整可读。

WeQ 的行为与签名：

| 操作 | 做法 |
| ---- | ---- |
| 删除消息 | 同样写 `(1,1)`（与 QQ 原生撤回字节一致），并先把原值记进 DeletedMsgStore |
| 恢复消息 | 从 store 取回原 `(40011,40012)` 写回，正文从未动过 |
| 识别删除 | `40011 = 1 AND 40012 = 1`；QQ 原生撤回与 WeQ 删除都命中，靠 DeletedMsgStore 区分 |
| 防撤回 | WeQ 自己改 40800 时顺手把 `40002`（msgRandom）也改掉——QQ 的撤回改写只动 40800 不动 40002，SQLite trigger 据此放行 WeQ、拦截 QQ 撤回 |

> 40002 平时就是个随机 tiebreaker，被拿去当「是我改的」信号对其它功能无影响。

---

[← 返回 nt_msg.db](./index.md)
