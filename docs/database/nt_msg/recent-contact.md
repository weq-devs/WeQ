# recent_contact_v3_table — 会话列表

`nt_msg.db` 里的**最近会话列表**，一行 = 一个会话（好友 / 群 / 临时会话 / 公众号 / 频道…）。
它是聊天软件左侧那一栏的数据源：会话名、头像、最后一条消息的外显文本、时间、免打扰状态全在这里。

对应 WeQ 解析实现：

| 文件 | 职责 |
| ---- | ---- |
| `packages/db/src/contact/recent_contact.ts` | 取行 + 列 → `RecentContact` |
| `packages/db/src/contact/types.ts` | `RecentContact` 的字段语义 |
| `packages/codec/src/proto/msg/40051.ts` | `40051` 预览列的 protobuf 外壳 |

---

## 一、这张表的定位

关键认识：**这张表是一份「冗余快照」，不是消息表的视图。**

会话的最新一条消息，其正文明明已经存在 `c2c_msg_table` / `group_msg_table` 里，
QQ 仍然把「发送者昵称 / 群名片 / 外显文本 / 头像路径」等一整套展示信息**再抄一份**进这张表。
原因很实际：渲染会话列表时不能为每个会话都去消息表里查一次、再去 profile 库查一次昵称，
那是 N 次跨库查询。抄一份进来，列表就是一条 `ORDER BY 40050 DESC LIMIT n`。

带来的两个后果，写代码时必须记住：

1. **这里的展示信息可能过时**。对方改了昵称、群改了名，只有下次这个会话来消息、这一行被重写时才会更新。
   要「当前」的昵称/群名，得去 `profile_info.db` / `group_info.db`，不能信这里。
2. **删掉这一行 ≠ 删掉聊天记录**。QQ 里「删除会话」删的就是这一行，消息表纹丝不动。
   WeQ 的「WeQ 助手」开关也正是这么做的（关掉只删 `recent_contact_v3_table` 的行，
   `c2c_msg_table` 从不动 —— 见 `packages/service/src/account/weq_assistant.ts`）。

## 二、列结构

WeQ 实际读取的列（`SELECT` 见 `recent_contact.ts`），按用途分组。

### 会话身份

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 41102 | — | INTEGER | 行主键。WeQ 只在**插入**伪造会话时用到（取 `MAX + 随机`），读取路径不关心 | 观测一致 |
| 40010 | `chatType` | INTEGER | 会话类型，见下方 [ChatType](#四chattype会话类型) | 已验证 |
| 40021 | `targetUid` | TEXT | **会话标识**：c2c 是对端 uid，群是群号 | 已验证 |
| 40030 | `targetUin` | INTEGER | 会话对端的 QQ 号（c2c 用；无则 0） | 已验证 |
| 40027 | — | INTEGER | 会话 sortNo，同 `nt_uid_mapping_table.48901`，与消息表的分区列同义 | 观测一致 |

> 注意 `40021` 一列同时兼任「好友 uid」和「群号」两种身份 —— 靠 `40010` 区分。
> 这与消息表的 `40021` 是同一约定。

### 最后一条消息

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 40001 | — | INTEGER | 最后一条消息的 msgId，指回消息表 | 观测一致 |
| 40003 | `msgSeq` | INTEGER | 最后一条消息的序列号。**未读数就是拿它减去已读 seq 算的**，见 [msg_unread_info_table](./unread-info.md) | 已验证 |
| 40011 | — | INTEGER | 最后一条消息的 msgType，枚举同 [40900 · MsgType](./40900.md#msgtypetag-40011) | 观测一致 |
| 40050 | `sendTime` | INTEGER | 最后一条消息的时间，unix 秒。无草稿时它就是排序时间，见 [`41136`](#41136--真正的排序键) | 已验证 |
| 41136 | — | INTEGER | **排序键**。无草稿时 = `40050`；有草稿时替换成草稿时间；置顶行另置 `2^47` 高位。见 [`41136` — 真正的排序键](#41136--真正的排序键) | 观测一致 |
| 40051 | `preview` | BLOB | **外显预览**，protobuf，见下方第三节 | 已验证 |

### 发送者展示信息（最后一条消息的发送者）

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 40020 | `senderUid` | TEXT | 发送者 uid | 已验证 |
| 40033 | — | INTEGER | 发送者 QQ 号 | 观测一致 |
| 40090 | `senderDisplayName` | TEXT | 发送者展示名，群聊场景主要是**群名片** | 已验证 |
| 40093 | `senderNick` | TEXT | 发送者昵称 | 已验证 |
| 40095 | `senderRemark` | TEXT | 发送者备注名 | 已验证 |

> 三个名字列的优先级由使用方决定。WeQ 的会话列表取 `senderDisplayName || senderNick`。

### 会话自身展示信息

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 40094 | `targetDisplayName` | TEXT | **会话名**：好友昵称 / 群名 | 已验证 |
| 41135 | `targetRemark` | TEXT | 会话备注名（好友备注） | 已验证 |
| 41110 | `targetAvatar` | TEXT | 会话头像。**是本地文件的绝对路径**，不是 URL —— QQ 直接读这个路径渲染 | 已验证 |
| 41148 | `targetGroupNick` | TEXT | 对方的**群名片**，只在「群里发起的临时会话」行上有值，其它场景为空 | 观测一致 |

> `41110` 是本地路径这一点被 WeQ 反向利用：「WeQ 助手」把自己的头像图片写进 QQ 自己的
> `nt_data/avatar/weq/` 目录，再把绝对路径填进这一列，QQ 就会像渲染任何缓存头像一样渲染它。

### 会话设置与来源

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 41220 | `notifyLevel` | INTEGER | **免打扰**。`0`/`1` = 正常提醒，其它值（实测 `4`）= 免打扰 | 已验证 |
| 60001 | `tempSourceGroupCode` | INTEGER | 临时会话的**来源群号**。非临时会话为 0 | 已验证 |

`41220` 是逆向出来的：开关某个群的免打扰、前后各 dump 一次整行做 diff，只有这一列变。
84 个群被这一列干净二分。`msg_unread_info_table` 里**没有**免打扰字段，别去那边找。

判定写法（`MainView.tsx`）：

```ts
function mutedFromNotifyLevel(notifyLevel: number | undefined): boolean {
  return notifyLevel !== undefined && notifyLevel !== 0 && notifyLevel !== 1;
}
```

`60001` 用于「群 xxx 的临时会话」这种标题回退：群还在我的群列表里就显示群名，退群了就退化成群号。

### 草稿与置顶标记（41103 / 41104 / 41108）

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 41103 | `topTime` | INTEGER | **置顶时间**，unix 秒。与 [recent_contact_top_table](./recent-contact-top.md) 的同名列逐秒相等；未置顶为 0 | 已验证 |
| 41104 | `pinned` | INTEGER | **置顶标记**：`1` = 已置顶，`0` = 未置顶 | 已验证 |
| 41108 | `draftTime` | INTEGER | **草稿更新时间**，unix 秒。与 [draft_storage_table_v1](./draft-storage.md) 同会话行的 `40050` 逐秒相等；无草稿为 0 | 已验证 |

这三列都只在极少数行上非零，且长期被误读 —— 因为最常见的观测环境里，「置顶」和「有草稿」
总是同时发生，两个特征叠在同一批行上。用下面这组对照样本才能把它们拆开
（162 行取 3 行，覆盖置顶 × 草稿的四种组合里的三种）：

| 会话 | 41103 | 41104 | 41108 | 置顶 | 有草稿 |
| ---- | ----- | ----- | ----- | ---- | ------ |
| `673646675`（群「喵喵喵」） | 1785509063 | 1 | 1790184773 | ✅ | ✅ |
| `u_LKt3…`（好友 eSTKim） | 1785509057 | 1 | 1790184913 | ✅ | ✅ |
| `1090396070`（群「开心快乐的跑步」） | 0 | 0 | 1790185263 | ❌ | ✅ |

由此定案：

- **`41104` 是置顶标记，不是草稿标记。** 判据是集合恒等：`41104 = 1` 的行集与
  `recent_contact_top_table` 的行集**完全相等**，而上面那个未置顶的草稿群 `41104 = 0`。
- **`41108` 是草稿时间。** 三行的 `41108` 都与 [draft_storage_table_v1](./draft-storage.md)
  对应行的 `40050` **逐秒相等**，与置顶无关。
- **`41103` 是置顶时间**，与 `recent_contact_top_table.41103` 逐秒相等（其含义见
  [recent-contact-top](./recent-contact-top.md#二列结构)）。

> 验证手法值得记一笔：`41108` 与 trigger 无关 —— `nt_msg.db` 里**一条 trigger 都没有**
> （`sqlite_master` 里 `type='trigger'` 零行），这个值是 QQ 进程自己写的。
> 用 SQL 往草稿表插一行（`40050` 写成未来时间）时 QQ 界面毫无反应，
> 只有在输入框里真的改动草稿才更新 —— 详细时间线见
> [draft-storage · 直接写表会被 QQ 认吗](./draft-storage.md#直接写表会被-qq-认吗)。

### `41136` — 真正的排序键

`41136` 常见值是「与 `40050` 相等」，很容易被当成无意义的时间镜像；但拿上面 3 行一比对，
它其实是个**复合排序键**，编码了「这条会话该排在列表的哪个位置」：

| 会话 | 40050（最后消息） | 41136 | 解释 |
| ---- | ----------------- | ----- | ---- |
| `1090396070` | 1790184124 | 1790185263 | = 草稿时间（草稿比最后消息新，会话应被顶上去） |
| `673646675` | 1790029015 | 140739278540101 | = `2^47` + 1790184773（草稿时间，外加置顶标记） |
| `u_LKt3…` | 1790182808 | 140739278540241 | = `2^47` + 1790184913（同上） |

规则可以这样概括：

```text
41136 = 2^47 × [已置顶] + 排序时间
排序时间 = 有草稿 ? 草稿时间 : 40050
```

会话因此会被草稿顶到前面：输入框里打了字，列表里那条会话就冒到最上面。置顶行再置上
bit 47（`2^47 = 140737488355328`），排序时一次比较就能把置顶组整体提前、组内仍按同一
时间轴排。

> 全表 162 行里 159 行 `41136 = 40050`，剩下 3 行正是上面这些有草稿的行 ——
> 所以「无草稿时 `41136 = 40050`」这个旧观察本身没错，只是**漏掉了有草稿时的情形**。

未验证的两点，别当成结论：

- **「有草稿就取草稿时间」还是「取两者较新者」分不出来。** 实测 3 行的草稿时间都晚于
  最后消息时间（刚打的草稿必然最新），两种解释给出同一个值。要区分得构造
  「仓库里有旧草稿 + 之后来了新消息」的场景。
- **bit 47 是「已置顶」标记**这一条只有 2 个样本支撑（实测有草稿的行恰好都置顶），
  归为观测一致而非已验证。

## 三、`40051` — 外显预览

会话列表里那句「张三：[图片]」的来源。它是 protobuf，外壳里只有一个 tag 同为 `40051` 的子消息：

```text
40051 (BLOB)
└── 40051  PreviewElementWire     ← 单个消息段，不是列表
    ├── …  与 40800 的 ElementWire 完全相同的全部字段
    └── 49093  displayText        ← 会话列表外显文本
```

理解要点：

- **它就是一个 `ElementWire`**（结构见 [40800 解析](./40800.md)），只是**单个**，不是 `repeated`。
  多消息段的消息（图 + 文）只挑第一段做预览。
- **多出来的只有一个 tag：`49093`**，装的是最终外显文本。图片消息这里就是 `"[图片]"`，
  也就是说**外显文案是 QQ 写进库的，不需要解析方自己按类型翻译**。

| tag | 字段名 | 类型 | 含义 | 置信度 |
| --- | ------ | ---- | ---- | ------ |
| 49093 | `displayText` | string | 会话列表外显的最新消息文本 | 已验证 |

解码同样先过 `sanitizeBytes` 容错（原因见 [40800 · 容错解码](./40800.md#六容错解码sanitizebytes)），
一个猜错类型的 tag 不至于让整个会话列表少一行。

## 四、ChatType（会话类型）

`40010` 的取值，来自 QQ NT 自身的 `KCHATTYPE*` 枚举（`packages/codec/src/domain/msg/enums.ts`）。
下表按「WeQ 是否实际渲染」分组，值全部来自枚举定义本身。

### 常规会话

| 值 | 名称 | 说明 |
| -- | ---- | ---- |
| 1 | KCHATTYPEC2C | 好友单聊 |
| 2 | KCHATTYPEGROUP | 群聊 |
| 3 | KCHATTYPEDISC | 讨论组（历史遗留） |
| 8 | KCHATTYPEDATALINE | 数据线（我的手机 / 电脑 / 平板），消息落在 `dataline_msg_table` |
| 134 | KCHATTYPEDATALINEMQQ | 数据线（手机 QQ） |

### 临时会话

| 值 | 名称 | 说明 |
| -- | ---- | ---- |
| 99 | KCHATTYPETEMPC2CFROMUNKNOWN | 来源未知的临时会话 |
| 100 | KCHATTYPETEMPC2CFROMGROUP | **群聊发起的临时会话**，来源群号在 `60001`，对方群名片在 `41148` |
| 101 | KCHATTYPETEMPFRIENDVERIFY | 好友验证 |
| 102 | KCHATTYPETEMPBUSSINESSCRM | 商家客服 |
| 103 | KCHATTYPETEMPPUBLICACCOUNT | 公众号 / 服务号 |
| 111 | KCHATTYPETEMPADDRESSBOOK | 通讯录来源 |
| 117 | KCHATTYPETEMPWPA | 网页发起会话 |
| 119 | KCHATTYPETEMPNEARBYPRO | 附近的人（Pro） |

### 系统 / 折叠入口

这些不是真人会话，而是各种「助手」「通知」的折叠入口。

| 值 | 名称 | 说明 |
| -- | ---- | ---- |
| 5 | KCHATTYPEBUDDYNOTIFY | 好友通知 |
| 6 | KCHATTYPEGROUPNOTIFY | 群通知 |
| 7 | KCHATTYPEGROUPHELPER | 群助手 |
| 30 | KCHATTYPESUBSCRIBEFOLDER | 订阅号折叠 |
| 40 | KCHATTYPEWEIYUN | 微云 |
| 41 | KCHATTYPEFAV | 收藏 |
| 42 | KCHATTYPEADELIE | Adelie（内部） |
| 104 / 109 | KCHATTYPEMATCHFRIEND(FOLDER) | 交友匹配（及其折叠） |
| 105 / 116 | KCHATTYPEGAMEMESSAGE(FOLDER) | 游戏消息（及其折叠） |
| 106 ~ 112 | KCHATTYPENEARBY* | 附近的人相关（助手 / 折叠 / 互动 / 打招呼折叠） |
| 113 | KCHATTYPECIRCLE | 圈子 |
| 115 | KCHATTYPESQUAREPUBLIC | 广场 |
| 118 / 201 | KCHATTYPESERVICEASSISTANT(SUB) | 服务号助手（及子项） |
| 131 | KCHATTYPERELATEACCOUNT | 关联账号 |
| 132 | KCHATTYPEQQNOTIFY | QQ 官方通知 |
| 133 | KCHATTYPEGROUPBLESS | 群祝福 |

### 频道（被 WeQ 排除）

| 值 | 名称 | 说明 |
| -- | ---- | ---- |
| 0 | KCHATTYPEUNKNOWN | 占位 |
| 4 | KCHATTYPEGUILD | 频道 |
| 9 | KCHATTYPEGROUPGUILD | 群频道 |
| 16 | KCHATTYPEGUILDMETA | **频道元信息** |

`16` 被 WeQ 显式过滤掉（`BLOCKED_CHAT_TYPES`）。原因是频道行**换了一套列布局**：
会话名在 `40091` 而不是 `40094`，预览嵌在 `41150` 而不是 `40051`，也没有头像列 ——
按常规列读出来是一行空白，不如不显示。

## 五、常见查询

会话列表（WeQ 的读法）：

```sql
SELECT "40003","40010","40020","40021","40030","40050","40051",
       "40090","40093","40094","40095","41110","41135","41148","41220","60001"
FROM recent_contact_v3_table
WHERE "40010" NOT IN (16)          -- 排除频道元信息行
ORDER BY "40050" DESC
LIMIT ? OFFSET ?;
```

`40050` 上有索引，会话数量本身也就几百，所以单条有序 `LIMIT` 足够，不需要分页优化。

> **注意排序键**：QQ 自己排序用的是 `41136`（见 [`41136` — 真正的排序键](#41136--真正的排序键)），
> 它会把「有草稿」的会话按草稿时间提前。上面这段是 WeQ 当前的读法 —— 只取每行的 `40050`，
> 再由上层按置顶表重排；会话有草稿时两边的先后可能不一致。

> 会话的**置顶**状态在
> [recent_contact_top_table](./recent-contact-top.md) 里有完整登记（靠 `40021` / `targetUid` 关联）；
> 本表的 `41103` / `41104` 也各存了一份置顶时间与置顶标记的副本。

---

[← 返回 nt_msg.db](./index.md)
