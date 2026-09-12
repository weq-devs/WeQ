# recent_contact_delete_storage — 删除会话

`nt_msg.db` 里的**删除会话表**，一行 = 一个被用户「删除会话」的会话。

对应 WeQ 解析实现：

| 文件 | 职责 |
| ---- | ---- |
| `packages/db/src/contact/deleted_session.ts` | 取行 + 列 → `DeletedSession` |
| `packages/db/src/contact/types.ts` | `DeletedSession` 的字段语义 |
| `packages/service/src/account/deleted_session.ts` | `DeletedSessionService`：判定 + 解析最后消息时间/预览 |

---

## 一、这张表的定位

关键认识：**「删除会话」删的是会话列表行，不是聊天记录。**

在 QQ 里对一个会话点「删除」，`recent_contact_v3_table` 里的那一行被**整体移除**
（消息表 `c2c_msg_table` / `group_msg_table` 纹丝不动 —— 消息还在，
用搜索或重新收到消息都能找回来），同时在这里留一条登记。

这与「隐藏会话」（[hidden_session_storage_table_v1](./hidden-session.md)）正好相反：

| | 隐藏会话 | 删除会话 |
| -- | -------- | -------- |
| `recent_contact_v3_table` 里的行 | **保留**（隐藏是标记） | **移除**（删除是移除） |
| 主列表出现方式 | 过滤掉，靠本表标记 | 自然消失，靠本表捞回来 |
| 「有效」判定 | 两表**都有** | 本表有、recent 表**没有** |

由此得出 WeQ 的判定规则：本表有记录、`targetUid` 格式合法、
**且**已经不在 `recent_contact_v3_table` 里 —— 三者齐备才算「删除会话」。
最后一条不是多余的：删除后对端再来一条新消息，会话行会重新出现在
`recent_contact_v3_table` 里（「复活」），这时它就是普通会话，不该再出现在删除面板里。

存在性检查同样走 `RecentContactDb.hasTargetUids` 精确查询，不用 `LIMIT 200` 的分页列表 ——
理由与隐藏会话相同：这里要判断的是「不在」，分页列表漏判会把复活会话误留、
把掉出前 200 名的删除会话误判。

## 二、列结构

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 1005 | `sessionKey` | TEXT | **会话标识**，格式 `"{chatType}_{uid}"`，见下节 | 已验证 |
| 40050 | `sendTime` | INTEGER | 删除前最后一条消息的时间，unix 秒。与 `recent_contact_v3_table.40050` 同义 | 已验证 |
| 49740 | `deleteTime` | INTEGER | **删除动作的时间**，unix **毫秒** | 已验证 |

要点：

- 注意 `49740` 是**毫秒**而 `40050` 是**秒** —— 同一张库里两种单位并存，别统一错。
- 与隐藏会话表不同，这里**有**最后消息时间，但**没有**预览列 ——
  外显预览仍然要回消息表查（见第五节）。

> WeQ 只读了这 3 列。表里可能还有其它列，但没有解析过，不写没验证的东西。

## 三、`1005` — sessionKey 的解析

这一列把会话类型和标识拼在一个字符串里，需要拆开：

```text
"{chatType}_{uid}"
  40010（数字）  40021（c2c 对端 uid 或群号）
```

WeQ 的拆法（`deleted_session.ts`）：按**第一个** `_` 切分，剩余部分整体当 uid ——
uid 本身可能含下划线，不能无脑 `split('_')`。两侧都非空、chatType 是有限数字才算合格，
不合格的行打 warn 后丢弃（`listDeletedSessions` 里 `filter` 掉 `null`）。

chatType 数值与 [recent_contact · ChatType](./recent-contact.md#四chattype会话类型) 同一枚举。
WeQ 的 service 只认三种（`deleted_session.ts`）：

| 值 | 含义 |
| -- | ---- |
| 1 | 普通 c2c |
| 10 | 临时会话（按 c2c 处理，回查 `c2c_msg_table`） |
| 2 | 群聊（回查 `group_msg_table`） |

其它值不渲染。注意这里拿到的是**数字**，而隐藏会话表解出来的是**枚举名** ——
两个面板的群聊判定写法因此不同（删除面板直接 `=== 2`，隐藏面板走 `classifyChatType`）。

## 四、常见查询

WeQ 的读法（整表）：

```sql
SELECT "1005","40050","49740" FROM recent_contact_delete_storage;
```

## 五、最后消息时间 / 预览的解析

`40050` 虽然有时间，但**没有预览**。和隐藏会话一样，
`DeletedSessionService` 对每个 `resolvable` 的会话回查消息表取最新一条
（c2c 走 `c2cMsgs.listLatest({ uid }, 1)`，群走 `groupMsgs.listLatest(群号, 1)`），
拿 `sendTime` / `senderUid` / 首个 Element 做行的时间与预览。

目前取到的时间**以消息表为准**（`40050` 列保留为原始数据，service 不直接用）。
查不到消息时 `sendTime = 0`、`preview = null`，行仍显示。

## 六、前端渲染

- 主会话列表里删除会话**自然不出现**（recent 表的行已经没了），不需要主动过滤 ——
  这是它与隐藏会话在 `MainView.tsx` 里处理方式的差别：隐藏会话要显式排除，
  删除会话只需按 `deletedSessions` 数据单独解析出来供点击后打开；
- 删除会话合并入口（`MergedSessionPanel`，`kind = 'deleted'`）只渲染
  `resolvable: true` 且 `targetUid` 非空的行；
- c2c 行的昵称/头像走 profile 解析（备注 > 昵称 > qid > uid 兜底），
  群行走群号 → 群名映射，解析不到就显示群号；
- IPC 路径：`account.listDeletedSessions`（`apps/desktop/src/main/ipc/routers/account.ts`）。

---

[← 返回 nt_msg.db](./index.md)
