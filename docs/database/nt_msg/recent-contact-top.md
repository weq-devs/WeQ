# recent_contact_top_table — 置顶会话

`nt_msg.db` 里的**置顶会话表**，一行 = 一个被置顶的会话。
QQ 会话列表顶部那几个「钉在最前面」的会话就来自这里。

对应 WeQ 解析实现：

| 文件 | 职责 |
| ---- | ---- |
| `packages/db/src/contact/recent_contact_top.ts` | 取行 + 列 → `RecentContactTop` |
| `packages/db/src/contact/types.ts` | `RecentContactTop` 的字段语义 |
| `packages/db/tools/recent_contact_top.ts` | 探针：打印置顶会话并 join 会话名 |

---

## 一、这张表的定位

关键认识：**这是一张「纯登记表」，只记「谁被置顶了、什么时候置的」，不带任何展示信息。**

它没有会话名、没有头像、没有最后一条消息 —— 这些全在
[recent_contact_v3_table](./recent-contact.md) 里。这与那张表刻意冗余展示信息的做法正好相反：
置顶是一条「用户设置」，改动频率低、数据量小（实测就两三行），没有冗余的必要。

所以使用方式是**两表 join**：读 `recent_contact_v3_table` 拿到会话，
再用本表的会话标识去标记哪些会话置顶、按 `41103` 决定置顶组内的先后。

## 二、列结构

整张表只有 5 列，全部列在下面（不是节选）。

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 41145 | `id` | INTEGER | 行主键，一个 64 位大整数。**不是会话标识**，读取路径不关心 | 观测一致 |
| 40010 | `chatType` | INTEGER | 会话类型，枚举同 [recent_contact · ChatType](./recent-contact.md#四chattype会话类型) | 已验证 |
| 41103 | `topTime` | INTEGER | **置顶时间**，unix 秒。置顶组内的排序键 | 已验证 |
| 1000 | `peerUid` | TEXT | **私聊**会话的对端 uid。群聊行为 `NULL` | 已验证 |
| 60001 | `groupCode` | INTEGER | **群聊**会话的群号。私聊行为 `NULL` | 已验证 |

要点：

- **`1000` 和 `60001` 二选一，另一个是 `NULL`**（不是 0、不是空串）。
  靠 `40010` 判断该读哪一列，也可以直接「哪列非空取哪列」。
- 注意 `60001` 在这里的含义和 `recent_contact_v3_table` **不一样**：
  那边的 `60001` 是「临时会话的来源群号」，这边是「被置顶的群本身」。同名不同义。
- `41103` 与 `recent_contact_v3_table` 的 `40050`（最后消息时间）无关。
  刚置顶一个死了半年的会话，它照样排最前。

实测两行（一群一私聊）：

```text
41145 = 339226880527203757   40010 = 2   41103 = 1785509063   1000 = NULL                       60001 = 673646675
41145 = 4391097541244030732  40010 = 1   41103 = 1785509057   1000 = "u_LKt3AdAIMP-CUfn6ydzDzw"  60001 = NULL
```

## 三、会话标识的归一化

`RecentContactTop.targetId` 把二选一的两列收敛成一个字符串，**刻意对齐
`RecentContact.targetUid`**（那一列同样兼任 uid / 群号两种身份）：

```ts
targetId = peerUid || (groupCode === 0n ? '' : groupCode.toString())
```

有了它，前端就是一次 Map 查表：

```ts
const topTimeByConv = new Map(tops.map((t) => [t.targetId, Number(t.topTime)]));
// conversation.id 就是 RecentContact.targetUid
const pinned = topTimeByConv.has(conversation.id);
```

## 四、常见查询

WeQ 的读法（整表，不分页 —— QQ 的置顶数量本来就只有个位数）：

```sql
SELECT "41145","40010","41103","1000","60001"
FROM recent_contact_top_table
ORDER BY "41103" DESC;
```

## 五、前端渲染

会话列表的排序变成两级（`MainView.tsx` 的 `conversations`）：

1. 置顶会话整体排在最前，组内按 `41103` 倒序；
2. 其余会话按最后一条消息时间倒序。

置顶状态经 `ConversationPreference.pinned` 下发给模板层。这里的 merge 顺序与免打扰
（`41220`）保持一致：**DB 值打底，本地手动偏好覆盖**，所以用户在界面上手动取消置顶时
不会被 DB 值顶回去。行上的表现是浅色底 + 时间左侧一枚图钉（`.conversation-row.pinned`）。

---

[← 返回 nt_msg.db](./index.md)
