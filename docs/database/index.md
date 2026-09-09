# 数据库分析

NTQQ 把数据分散在若干个 SQLCipher 加密数据库里。本栏目记录 WeQ **实际解析过**的表与字段 ——
全部依据自己的解析实现手写维护，不转述二手资料；未解析过的部分宁可留空，也不写没验证过的东西。

## 数据库一览

| 数据库 | 内容 | 文档 |
| ------ | ---- | ---- |
| `nt_msg.db` | 聊天记录本体：消息行、会话列表、未读状态 | [nt_msg.db](./nt_msg/index.md) |
| `profile_info.db` | 好友 / 陌生人资料、好友列表与分组 | [profile_info.db](./profile_info/index.md) |
| `guild_msg.db` / `guild1.db` | QQ 频道：私聊会话、消息、用户资料（PC 与安卓文件名不同） | [guild](./guild.md) |
| `group_info.db` | 群资料、群成员、公告、精华 | [group_info.db](./group_info.md) |
| `collection.db` | QQ 收藏 | [collection.db](./collection.md) |
| `emoji.db` | 系统表情、商城表情包 | [emoji.db](./emoji.md) |
| `login.db` | 登录过的账号列表（固定密钥，native 解析） | [login.db](./login.md) |
| `misc.db` | 杂项（好友在线状态缓存） | [misc.db](./misc.md) |
| `buddy_msg_fts.db` / `group_msg_fts.db` | 消息全文搜索索引 | [fts](./fts.md) |

> 📌 数据库**解密**（取密钥、去文件头、SQLCipher 参数）属于原理部分，见
> [原理总览](../principles/index.md)。

## 字段表约定

各页的字段表统一使用「置信度」一列区分三档：

| 档位 | 含义 |
| ---- | ---- |
| 已验证 | 主动构造场景 / 前后 diff 确认过语义 |
| 观测一致 | 大量真实样本上表现一致，但没有主动构造验证 |
| 推测 | 只是看起来合理，**未验证** —— 会显式标注 |

---

[← 返回文档中心](../README.md)
