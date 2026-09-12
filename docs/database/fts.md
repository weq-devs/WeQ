# buddy_msg_fts.db / group_msg_fts.db — 消息全文搜索

QQ 自带的**消息全文搜索索引**，两个独立的库：

| 库 | 内容表 | 覆盖范围 |
| -- | ------ | -------- |
| `buddy_msg_fts.db` | `buddy_msg_fts` | 私聊消息文本 |
| `group_msg_fts.db` | `group_msg_fts` | 群聊消息文本 |

两个库的**表结构、列布局完全一致**，只是数据范围不同。位置都在账号目录的
`nt_db/` 子目录下（和 `nt_msg.db` 同目录）。

对应 WeQ 解析实现：

| 文件 | 职责 |
| ---- | ---- |
| `packages/db/src/msg/buddy_msg_fts.ts` | 私聊搜索（`BuddyMsgFtsDb`） |
| `packages/db/src/msg/group_msg_fts.ts` | 群聊搜索（`GroupMsgFtsDb`） |
| `packages/db/src/msg/search_index.ts` | WeQ 自建的 trigram FTS5 加速索引（`MsgSearchIndexDb`） |
| `packages/db/src/msg/types.ts` | `BuddyMsgFtsHit` 命中结构 |
| `packages/service/src/account/msg_search.ts` | service 层组装（uid → sortNo 翻译等） |

---

## 一、一个库里有两样东西

以 `buddy_msg_fts.db` 为例：

- `buddy_msg_fts` —— **普通内容表**：拍平的消息文本 + 身份键列（WeQ 读的就是它）；
- `buddy_msg_fts_fts` —— 建在内容表上的 **FTS5 虚表**，声明
  `tokenize = 'pinyin_letter 0'`。

### 为什么 WeQ 不用 QQ 的 FTS5 表

`pinyin_letter` 是 QQ 私有分词器，我们的 SQLCipher 构建里**没有注册**，
任何打向 `buddy_msg_fts_fts` 的查询直接报 `no such tokenizer: pinyin_letter`。
所以 WeQ 在内容表上用 `LIKE '%kw%'`（子串匹配，不依赖分词器）粗筛，
再用 JS 的相关性启发式对候选池重排。

## 二、列结构

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 40001 | `msgId` | INTEGER | 消息 id，UNIQUE，回指 `c2c/group_msg_table` | 已验证 |
| 40003 | `msgSeq` | INTEGER | 会话内 seq，**与主消息表同值**，可直接驱动跳转 | 已验证 |
| 40010 | `chatType` | INTEGER | 会话类型（1 = c2c，2 = 群） | 已验证 |
| 40020 | `senderUid` | TEXT | 发送者 uid | 已验证 |
| 40021 | `targetUid` | TEXT | 会话标识（对端 uid / 群号）——**无索引** | 已验证 |
| 40027 | `sortNo` | INTEGER | 会话分区键，**有索引**：私聊 = `c2c_msg_table.40027` 的 sortNo，群聊 = 群号 | 已验证 |
| 40050 | `sendTime` | INTEGER | 发送时间（unix 秒），候选池的排序键 | 已验证 |
| 41701 | `content` | TEXT | **拍平的可搜索正文**（已无 40800 protobuf，纯文本） | 已验证 |
| 41702 | `fileName` | TEXT | 文件名（文件消息才有），单独可搜 | 观测一致 |

与主消息库的关系：这张表是 `nt_msg.db` 消息行的**投影索引** ——
只存身份键 + 拍平文本，没有消息体。命中后拿 `40001`/`40003` 回消息表取原始行。

### 快慢路径的约定与主消息表一致

- 私聊按会话过滤**必须走 `40027`（sortNo，有索引）**，调用方先用 `UidMap`
  把 uid 翻译成 sortNo；`40021`（uid）无索引，只作翻译不到时的兜底；
- 群聊 `40027` 就是群号，无需翻译。

## 三、搜索的实现要点

候选池策略（两张表相同）：`LIMIT = max(limit × 20, 100)`，封顶 500 ——
先按时间倒序粗取一批 LIKE 命中，相关性重排后裁到 `limit`。
上限防止热词把整表拖进来。

群表的两个特殊查询：

- **按文件名搜**：只匹配 `41702`；
- **热词的会话排行**：`GROUP BY 40027` 统计命中数取 Top —— 内层 `LIMIT 200000`
  有界扫描，超热词的计数是近似值，但 Top 会话足够正确。

WeQ 的读法：

```sql
SELECT "40001","40010","40021","40020","41701","40050","41702","40003"
FROM group_msg_fts
WHERE "40027" = ? AND ("41701" LIKE ? ESCAPE '\' OR "41702" LIKE ? ESCAPE '\')
ORDER BY "40050" DESC
LIMIT ?;
```

## 四、WeQ 自建的 trigram 加速索引

`LIKE '%kw%'` 没有任何索引能帮上忙：群表 149 万行的一次子串扫描要数秒，
`GROUP BY` 排行更慢。WeQ 的解法（`MsgSearchIndexDb`）：

1. `fastDecryptDatabase`：native 一次性把加密源库解成**明文 SQLite** 文件
   （518MB 群库约 1.3s）；
2. 在明文库里建 `fts5(tokenize='trigram')` 虚表 `weq_fts_idx`，
   一条 `INSERT INTO … SELECT` 灌满 —— 我们的构建带 trigram 分词器；
3. 之后 MATCH 查询毫秒级返回；建完**drop 掉源内容表**省磁盘。

配套机制：

- **增量同步**按会话走 `40003`（msgSeq）水位线，从加密源小批量读入；
- **不能用全局 rowid/msgId 游标**：`41700/40001` 是 QQ 自己分配的，
  新插的行可能排在历史最大值之下，rowid 游标会静默漏行 ——
  改用 `weq_fts_keys` 表记录每个已索引的 srcRowid，重跑/崩溃/重试都不会重复建索引；
- 源库指纹同时记录 `.db` 与 `-wal`（QQ 常驻 WAL 模式，主文件 size/mtime 不动）；
- 索引 schema 变更用 `weq_fts_meta` 版本号（当前 `'5'`）强制全量重建；
- 任何失败（QQ 占用、解密失败…）**回退到 LIKE 扫描**，搜索功能永不因索引挂掉。

> 导入的静态备份目录可能根本没有 fts 库 —— 这是常态而非错误，
> 路径解析返回 `null`，搜索降级为不可用或走主库扫描。

---

[← 返回数据库分析](./index.md)
