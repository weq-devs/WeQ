# hidden_session_storage_table_v1 — 隐藏会话

`nt_msg.db` 里的**隐藏会话表**，一行 = 一个被用户「隐藏聊天」的会话。
在 QQ 里对一个会话点「隐藏」，记录就落到这里。

对应 WeQ 解析实现：

| 文件 | 职责 |
| ---- | ---- |
| `packages/db/src/contact/hidden_session.ts` | 取行 + 列 → `HiddenSession` |
| `packages/db/src/contact/types.ts` | `HiddenSession` 的字段语义 |
| `packages/codec/src/proto/msg/43002.ts` | `43002` 载荷列的 protobuf 定义（`HiddenSessionBody` / `HiddenSessionEntry`） |
| `packages/service/src/account/hidden_session.ts` | `HiddenSessionService`：两表对缝 + 解析最后消息时间/预览 |

---

## 一、这张表的定位

关键认识：**QQ 的「隐藏」是一个标记，不是移除。**

与「删除会话」（见 [recent_contact_delete_storage](./deleted-session.md)）不同，
隐藏一个会话时，它在 `recent_contact_v3_table` 里的那一行**原样保留**，
QQ 只是额外在这里登记一条记录。会话列表里看不见它，是因为读取方要按本表过滤。

由此得出 WeQ 的判定规则：**两表都有才算「隐藏会话」** ——
本表里有记录、**且** `recent_contact_v3_table` 里那行还在，才渲染进隐藏会话面板。
只查本表是不够的：本表可能残留历史记录，对应会话早已不在会话列表里。

这个存在性检查必须走 `RecentContactDb.hasTargetUids` 的**精确查询**，
不能用 `getRecentContact` 的 `LIMIT 200` 列表来判断 ——
久未活跃的隐藏会话早就掉出最近会话前 200 名，用分页列表判断会把它误杀
（`HiddenSessionService` 开头的注释就是为这个坑写的）。

## 二、列结构

整张表只有 2 列（不是节选）：

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 43001 | `storageKey` | TEXT | 行主键。**不透明的存储 key**，不同行观测到的格式还不一样，不要解析它猜含义 | 观测一致 |
| 43002 | `entry` | BLOB | protobuf 载荷，见下节 | 已验证 |

这张表**没有时间列、没有预览列** —— 最后消息时间和预览都得拿 `targetUid`
回 `c2c_msg_table` / `group_msg_table` 查（见第五节）。

> WeQ 只读了这 2 列。表里可能还有其它列（如排序、时间），但没有解析过，不写没验证的东西。

## 三、`43002` — protobuf 载荷

外壳里只有一个 tag 同为 `43002` 的子消息 `HiddenSessionEntry`：

```text
43002 (BLOB)
└── 43002  HiddenSessionEntry
    ├── 40010  chatType    ← 会话类型，枚举同 recent_contact · ChatType
    ├── 40020  targetUin   ← 对端 QQ 号（字符串形式）
    ├── 40021  targetUid   ← 会话标识：c2c 是对端 uid，群是群号
    ├── 49702  flag49702   ← 布尔标记，含义未定
    ├── 49703  flag49703   ← 布尔标记，含义未定
    ├── 49704  flag49704   ← 布尔标记，含义未定
    └── 49705  flag49705   ← 布尔标记，含义未定
```

三个身份 tag（40010/40020/40021）沿用 `recent_contact_v3_table` 的同一套约定，
等于把会话身份**冗余抄了一份**进来 —— 这也是为什么回查消息表和会话列表都靠 `40021` 就够。

### 四个 flag（49702 ~ 49705）

逆向样本太少（总共 3 行，来自真实安卓备份），没钉死含义。
观测到的取值：全 false，或恰好 49704/49705 之一为 true ——
**疑似** c2c/群聊的判别标记，但未确认。WeQ 保留原始布尔值而不猜名字
（`HiddenSession.flags`）。

### 脏行问题

3 行样本里有 1 行很特殊：**没有 chatType、没有 targetUin，`targetUid` 还是个畸形值**
（形如 `<自己的uid>接一串数字`，不是合法 uid）—— 疑似旧版 QQ 的残留/半截写入。

处理约定：`targetUid` 解析不到真实联系人的行按**不可渲染**处理，而不是猜它的类型。
WeQ 用两个格式正则把门（`HiddenSessionService`）：

```ts
const UID_PATTERN = /^u_[\w-]{20,}$/;      // c2c：u_ + base64url 风格
const GROUP_CODE_PATTERN = /^\d+$/;        // 群：纯数字群号
```

格式不过关，或者 `chatType` 是 `'unknown'`（tag 缺失），直接 `resolvable: false`。

## 四、常见查询

WeQ 的读法（整表，实测只有几行，无需分页）：

```sql
SELECT "43001","43002" FROM hidden_session_storage_table_v1;
```

`43002` 解码同样先过 `sanitizeBytes` 容错（原因见
[40800 · 容错解码](./40800.md#六容错解码sanitizebytes)），一行的 protobuf 烂掉不能拖垮整个面板。

## 五、最后消息时间 / 预览的解析

本表不带时间预览，所以 `HiddenSessionService` 对每个 `resolvable` 的会话回查消息表取最新一条：

- c2c（`KCHATTYPEC2C`）：`c2cMsgs.listLatest({ uid }, 1)`；
- 群（`KCHATTYPEGROUP`）：`groupMsgs.listLatest(群号, 1)`，按群号查。

拿到的 `sendTime` / `senderUid` / 首个 Element 就是隐藏会话行的时间与预览，
与普通会话行（`recent_contact_v3_table.40050/40051`）对齐后统一排序。
查不到消息时 `sendTime = 0`、`preview = null`，行仍显示。

## 六、前端渲染

- 主会话列表里**排除**本表命中的会话（`MainView.tsx` 过滤时同时查两表）；
- 列表最上方渲染一枚固定的「隐藏会话」入口行（`HiddenSessionRow.tsx`），仅当至少有一个隐藏会话时出现；
- 点开后是 `MergedSessionPanel`（`kind = 'hidden'`），只渲染 `resolvable: true` 的行；
  面板里的 `resolvable` 已经蕴含「两表都有」的判定，前端不再判一次；
- **注意**这里的 `chatType` 是枚举名字符串（如 `"KCHATTYPEGROUP"`），不是数字 ——
  判群聊要走 `classifyChatType`，不能拿 `typeof === 'number'` 硬判，否则群聊永远落进单聊分支；
- IPC 路径：`account.listHiddenSessions`（`apps/desktop/src/main/ipc/routers/account.ts`）。

---

[← 返回 nt_msg.db](./index.md)
