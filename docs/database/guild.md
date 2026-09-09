# guild — 频道（QQ 频道）数据库

QQ 频道（guild）的数据**不在 `nt_msg.db` 里**，而是独立的一组库文件。
WeQ 目前解析的是**频道私聊**（DM）链路：会话列表、消息行、频道用户资料缓存。
频道区消息（在频道里发言的公开消息流）尚未解析。

对应 WeQ 解析实现：

| 文件 | 职责 |
| ---- | ---- |
| `packages/db/src/guild/direct_node.ts` | `direct_node_list_table` → `GuildDirectSession` |
| `packages/db/src/guild/guild_msg.ts` | `guild_msg_table` → `GuildDirectMsg` |
| `packages/db/src/guild/profile.ts` | `t_GPro_CommonUserProfile_v2` → `GuildCommonProfile` |
| `packages/db/src/guild/types.ts` | 上述领域形状的字段语义 |
| `packages/codec/src/proto/guild/direct_preview.ts` | 会话列表预览列的 protobuf（信封结构，见第三节） |
| `packages/service/src/account/guild_direct.ts` | `GuildDirectService`：会话视图、头像 URL 规则、导出元数据 |

---

## 一、PC 与安卓的库文件命名差异（重点）

频道是 WeQ 唯一遇到「**同一张表在不同端的物理文件名不同**」的业务，
写代码时必须两端都照顾到：

| 表 | PC NTQQ | 安卓 QQ 备份 |
| -- | ------- | ------------ |
| `direct_node_list_table`（私聊会话列表） | `guild_msg.db` | `guild_msg.db`（同名） |
| `guild_msg_table`（消息行） | `guild_msg.db` | `guild_msg.db`（同名） |
| `t_GPro_CommonUserProfile_v2`（用户资料缓存） | `guild1.db` | `gpro_v1-6_<uid>.db` |

要点：

1. **会话/消息表两端都在 `guild_msg.db`**，这条路径两端通用；
2. **资料缓存表在 PC 是 `guild1.db`，安卓备份里没有 `guild1.db`** ——
   同一张 `t_GPro_CommonUserProfile_v2` 放在了同目录的 `gpro_v1-6_<uid>.db` 里
   （uid 直接写在文件名中，形如 `gpro_v1-6_u_xxxxx.db`，匹配正则
   `^gpro_v[\d-]+_(u_[A-Za-z0-9_-]+)\.db$`）；
   解析方必须做这个 fallback：先找 `guild1.db`，找不到再扫 `gpro_*` 文件
   （见 `packages/account/src/static_session.ts` 的 `resolveGuildProfileCacheDb`）；
3. **密钥体系也不同**：
   - PC：guild 库沿用账号主 `dbKey`；
   - 安卓：`gpro_*` 库的 SQLCipher 密钥**独立于账号主密钥**，按「文件路径 + 账号 uin」
     单独派生（`ntHelper.getGuildDbKey(dbPath, uin)`，见 `packages/native/src/types.ts`）；
     其余库（包括 `guild_msg.db`）仍用主密钥；
   - 明文解密目录（无 dbKey）统一不开密钥。
4. 顺带一提，安卓的 `gpro_*` 文件还有一个特殊用途：**uid 识别**。
   PC 目录没有这种文件，所以「从目录内容反推 uid」这条路只对手机备份成立
   （`deriveAndroidDbKey` 用它拿 uid 再推导主密钥）。
5. 判断一个库是不是「安卓频道库」的统一写法是 `basename(dbPath).startsWith('gpro_')`
   （`db_decrypt.ts` / `db_explorer.ts` / `static_session.ts` 三处一致）。

文件缺失的语义：频道库可能整个不存在（账号没用过频道），
构造 accessor 是**惰性的**（不真正打开文件），查询侧自行容错 ——
`GuildDirectService.listSessions` 捕获异常后返回空列表，不影响主会话列表。

## 二、`guild_msg.db` — 会话列表 + 消息行

一个文件装两张表：私聊会话列表 + **全部**频道消息。

### 1. `direct_node_list_table` — 频道私聊会话列表

这张表是私聊列表的**唯一事实来源**。
不允许靠扫 `guild_msg_table` 找特征行来推导会话。

WeQ 实际读取的列：

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 40022 | `directGid` | TEXT | 直连路由 gid，**行主键** | 已验证 |
| 40027 | `nodeId` | INTEGER | **会话节点 id**，进 `guild_msg_table` 的分区键（有索引） | 已验证 |
| 40021 | — | TEXT | 同一个 nodeId 的字符串形式 | 观测一致 |
| 40050 | `lastTime` | INTEGER | 最新消息时间，unix 秒，**列表排序键** | 已验证 |
| 40003 | `lastSeq` | INTEGER | 最新消息 seq | 已验证 |
| 42051 | `peerTinyId` | INTEGER | 对端的**频道 tiny id**，join `t_GPro_CommonUserProfile_v2` 的键 | 已验证 |
| 42052 | `guildId` | INTEGER | 这条私聊所属的频道 id | 已验证 |
| 42053 | `guildName` | TEXT | 频道名 | 已验证 |
| 42054 | `nickGlobal` | TEXT | 对端的**跨频道全局昵称** | 已验证 |
| 42055 | `nickChannel` | TEXT | 对端在**本频道内**的昵称 | 已验证 |
| 40051 | `preview` | BLOB | 最新消息预览，**信封结构**，见第三节 | 已验证 |

显示名优先级（`GuildDirectService`）：
`nickChannel || nickGlobal || profile.nick || peerTinyId`。

WeQ 的读法（整表，列表很小，无需分页）：

```sql
SELECT "40022","40027","40021","40050","40003","42051","42052","42053","42054","42055","40051"
FROM direct_node_list_table
ORDER BY "40050" DESC;
```

### 2. `guild_msg_table` — 频道消息行

这张表存**所有**频道消息（频道区公开消息 + 私聊）。
一段私聊 = `40027` 等于该会话 nodeId 的那些行。

可用的复合索引是 `(40027, 40003)` 和 `(40002, 40003, 40027)`，
所以查询**永远按 `40027 = nodeId` 过滤、按 `40003` 排序**，绝不要按文本列查。

WeQ 实际读取的列：

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 40001 | `msgId` | INTEGER | 消息 id，行主键 | 已验证 |
| 40003 | `msgSeq` | INTEGER | 会话内序列号，**翻页游标** | 已验证 |
| 40027 | `nodeId` | INTEGER | 会话分区键 | 已验证 |
| 40026 | `senderTinyId` | INTEGER | 发送者 tiny id（整数形式） | 已验证 |
| 40025 | — | TEXT | 同一 id 的字符串形式（40026 为 0 时取它） | 已验证 |
| 40013 | `sendType` | INTEGER | 发送方向：`0` = 对端发的；其它值（实测 `2`）= 本账号设备发的 | 已验证 |
| 40050 | `sendTime` | INTEGER | 发送时间，unix 秒 | 已验证 |
| 40011 | `msgType` | INTEGER | 消息类型 | 观测一致 |
| 40012 | `subType` | INTEGER | 消息子类型 | 观测一致 |
| 40800 | `msgBody` | BLOB | 消息正文，protobuf `repeated ElementWire`，**结构与 nt_msg.db 的 40800 完全一致**，见 [40800 解析](./nt_msg/40800.md) | 已验证 |
| 40801 | `dress` | BLOB | 消息装扮，同 [40801](./nt_msg/40801.md) | 已验证 |

与 `nt_msg.db` 消息表的同构性是刻意的：**列号同一套编号体系**（40001/40003/40050/40800…），
但身份体系不同 —— 这里没有 uid/uin，发送者一律是**频道 tiny id**。

翻页契约与 c2c 相同（seq 窗口）：

```sql
-- 最新一页（新→旧）
SELECT … FROM guild_msg_table WHERE "40027" = ?
ORDER BY "40003" DESC, "40050" DESC, "40001" DESC LIMIT ?;
-- 更旧一页：AND "40003" < ?；更新一页：AND "40003" > ?（旧→新）
```

seq 并列时回退到时间、msgId，保证多次翻页结果稳定。

几个辅助查询（导出链路用）：

- 每会话消息数：`GROUP BY "40027"` 一次取全（避免逐会话 N+1）；
- 自己的 tiny id：`WHERE "40027" = ? AND "40013" != 0 LIMIT 1` 的 `40026` ——
  频道私聊**没有 QQ 号**，发送者身份全靠 tiny id；
- 导出媒体/装扮补全阶段按 `40001` 回读原始 40800/40801 blob。

## 三、`40051` — 频道私聊的预览信封

频道私聊列表的 `40051` 与 `recent_contact_v3_table.40051` **不是同一种形状**：

```text
recent-contact 预览（对照）：
40051 (BLOB)
└── 40051  PreviewElementWire          ← 直接就是消息段

频道私聊预览（guild_msg.db）：
40051 (BLOB)
└── 40051  DirectNodePreviewEnvelope  ← 整条「最新消息记录」信封，repeated
    ├── 40011  msgType
    ├── 40020  对端 tiny id（文本）
    ├── 40021  nodeId（文本）
    ├── 40022  directGid
    ├── 40041  发送状态（2 = 成功）
    ├── 40050  发送时间
    ├── 40051  PreviewElementWire（repeated）← 预览元素在信封里再套一层
    └── 40090/40093  不透明哈希对（观测值相同）
```

解码策略（`direct_node.ts` 的 `decodePreview`）：

1. 先按信封结构解（`DirectNodePreviewBody`），展开每层信封的 `40051` 元素列表；
2. 解不开再回退按 recent-contact 形状解（顶层直接是元素）——
   确实存在这种行，两种形状都要能吃；
3. 多个元素时优先取**有正文的 text 段**，否则取第一个带 `displayText` 的，再否则第一个元素；
4. 频道缓存元素经常**没有外显文本**（display text 缺失比 c2c 常见得多），
   消费方必须容忍空预览视图，不要假设一定有文字。

解码前同样过 `sanitizeBytes` 容错，一列解烂不影响整个列表。

## 四、`t_GPro_CommonUserProfile_v2` — 频道用户资料缓存

频道用户没有 QQ 号，全库以 **tiny id** 为主键。列名这一张表是**蛇形命名**
（不是 QQ 常见的纯数字列号）：

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| `tiny_id_` | `tinyId` | INTEGER | 频道 tiny id，主键 | 已验证 |
| `nick_name_` | `nick` | TEXT | 全局昵称 | 已验证 |
| `avatar_meta_` | `avatarMeta` | TEXT | 头像句柄，**不是 URL**，见下 | 已验证 |

物理文件位置见第一节：PC `guild1.db`，安卓 `gpro_v1-6_<uid>.db`。

批查语义（`listByTinyIds`）：查不到的 id 直接缺席于结果，**不抛错** ——
资料缓存陈旧时降级为「无资料」，不能让整个私聊列表挂掉。id 为 0 的行直接跳过。

### `avatar_meta_` → 头像 URL

`avatar_meta_` 是 QQ 存的「头像句柄」，URL 要自己拼（`guildAvatarUrlFromMeta`，
有单测覆盖 `service/test/misc_pure.test.ts`）。观测到两种格式：

| 句柄格式 | 拼出的 URL |
| -------- | ---------- |
| `0#k-<token>&kti=<…>#60#<ts>` | `https://thirdqq.qlogo.cn/g?b=oidb&k=<token>&kti=<…>&s=0`（拆 `#` 后第一段按 `&` 塞 query） |
| `1#<uuid>#31#<ts>` | `https://qqchannel-profile-1251316161.file.myqcloud.com/<uuid>/140` |

其它前缀返回 `null`，调用方回退默认头像。自己（主账号）有 QQ 号，头像走与 c2c 导出
同款的 `thirdqq.qlogo.cn` qlogo CDN，不用这套 meta。

## 五、会话视图与导出（service 层）

`GuildDirectService` 把三张表拼成会话视图：

- 会话列表：`direct_node_list_table` 整表 + 按 tinyId 批查资料 + `GROUP BY 40027` 的消息数；
- 消息翻页：`listLatest / listBefore / listAfter`（seq 窗口契约，与 c2c 一致）；
- 显示名：频道昵称 > 全局昵称 > 资料昵称 > tiny id；
- 导出身份快照（`buildExportMeta`）：对端取 `direct_node_list_table` + 资料库；
  自己取「该会话里自己发的第一条消息的 tinyId」+ 主账号资料库的 QQ 号/昵称；
  **`senderUin` 统一为空串** —— 频道消息不可能是漫游拉来的，没有 uin 可填。

IPC 路径见 `apps/desktop/src/main/ipc/routers/account.ts`（`account.guildDirect.*`）。

## 六、未解析部分

- **频道区公开消息流**：`guild_msg_table` 里非 DM 分区的行（频道内发言）没有解析；
- `guild_msg.db` / `guild1.db` 里其余的表（如 `t_GPro_ProfileInfo` ——
  service 层注释明确**不用**它，资料一律走 `t_GPro_CommonUserProfile_v2`）；
- 频道身份体系（tiny id ↔ 频道 id ↔ 成员）的完整映射表。

未验证的东西不写，等真实解析后再补。

---

[← 返回数据库分析](./index.md)
