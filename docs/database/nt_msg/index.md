# nt_msg.db — 消息数据库

`nt_msg.db` 是 NTQQ 存贮**聊天记录本体**的数据库：消息行、会话列表、未读状态都在这里。
本栏目的内容全部由 WeQ 依据自己的解析实现手写维护。

## 表一览

| 表 | 内容 | 文档 |
| -- | ---- | ---- |
| `c2c_msg_table` | 好友单聊消息 | [消息行](#消息行) |
| `group_msg_table` | 群聊消息（结构同 c2c） | [消息行](#消息行) |
| `dataline_msg_table` | 数据线消息（我的手机 / 电脑 / 平板，结构同 c2c） | [消息行](#消息行) |
| `recent_contact_v3_table` | 会话列表 | [recent-contact](./recent-contact.md) |
| `recent_contact_top_table` | 置顶会话 | [recent-contact-top](./recent-contact-top.md) |
| `msg_unread_info_table` | 未读信息 + 提醒高亮 | [unread-info](./unread-info.md) |
| `nt_uid_mapping_table` | uid ↔ uin ↔ sortNo 目录 | [下见](#nt_uid_mapping_table) |
| `draft_storage_table_v1` | 草稿：输入了但还没点发送的内容 | 暂未解析 |

### 消息行

三张消息表的**列布局完全一致**，差别只在会话维度（c2c 按 sortNo 分区、群按群号）。
一行里最复杂的是两个 protobuf 列：

| 列    | 名称                 | 结构                              | 说明                                                   |
| ----- | -------------------- | --------------------------------- | ------------------------------------------------------ |
| 40800 | 消息正文（MsgBody）  | `repeated ElementWire`            | 一条消息的富文本消息段序列，见 [40800 解析](./40800.md) |
| 40900 | 消息缓存（MsgCache） | `repeated MsgCache`（可递归嵌套） | 转发/引用时缓存的源消息快照，见 [40900 解析](./40900.md) |

> 📖 建议先读 [40800 解析](./40800.md) 的前半部分 —— 「扁平信封」与「文件族共用字段」
> 两节是理解所有消息段的前提，各消息段文档不再重复这些内容。

### nt_uid_mapping_table

账号级的身份目录，三列：

| 列 | 含义 |
| -- | ---- |
| 48901 | sortNo —— 该账号给每个交互过的对端分配的 1 起递增小整数 |
| 48902 | uid —— 其它地方通用的不透明对端标识 |
| 1002 | uin —— 对端 QQ 号 |

它之所以重要：`c2c_msg_table` 的**会话分区列是 `40027`（= 这里的 sortNo）**，
所有有用的复合索引都建在它上面（`(40027,40003)` 等）；而应用层是按 uid 找会话的，
`40021` 恰恰**没有索引**。所以走快路径查 c2c 消息，必须先 uid → sortNo 翻译一次。
这张表很小且稳定，WeQ 在会话启动时整表读进内存（`UidMap`）常驻。

---

## 消息段（Element）索引

`40800` 由若干消息段（Element）组成，每段以 `elementType` 区分类型。各类型的字段解析见下；
未观测到的 elementType（12/13/15/17/18/19/20/22/24/25/29/43/44）不单独成篇，
完整枚举见 [40800 解析 · elementType 全表](./40800.md#elementtype-全表)。

| elementType | 名称                  | 文档                                        |
| ----------- | --------------------- | ------------------------------------------- |
| 1           | 文本 / @              | [text](./elements/text.md)                  |
| 2           | 图片                  | [pic](./elements/pic.md)                    |
| 3           | 文件                  | [file](./elements/file.md)                  |
| 4           | 语音                  | [ptt](./elements/ptt.md)                    |
| 5           | 视频                  | [video](./elements/video.md)                |
| 6           | 系统表情              | [face](./elements/face.md)                  |
| 7           | 回复引用              | [reply](./elements/reply.md)                |
| 8           | 灰字提示              | [gray-tip](./elements/gray-tip.md)          |
| 9           | 红包 / 转账           | [wallet](./elements/wallet.md)              |
| 10          | ARK 卡片              | [ark](./elements/ark.md)                    |
| 11          | 商城表情              | [mface](./elements/mface.md)                |
| 14          | Markdown              | [markdown](./elements/markdown.md)          |
| 16          | 合并转发              | [multi-msg](./elements/multi-msg.md)        |
| 21          | 通话记录              | [call](./elements/call.md)                  |
| 23          | 在线文件              | [online-file](./elements/online-file.md)    |
| 26          | 空间动态提示          | [qq-dynamic](./elements/qq-dynamic.md)      |
| 27          | 弹射表情              | [emoji-bounce](./elements/emoji-bounce.md)  |
| 28          | 位置共享              | 仅一个字段，见 [40800 解析](./40800.md#elementtype-全表) |
| 30          | 在线文件夹            | [online-folder](./elements/online-folder.md)|

---

[← 返回数据库分析](../index.md)
