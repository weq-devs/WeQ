# 文档待办总目录

本页跟踪 `docs/` 下**非使用手册**部分（原理 / 架构 / 数据库分析）的编写进度。
使用手册（`docs/guide/`）由维护者本人撰写，不在本表范围内。

图例：`✅ 已完成` · `🚧 进行中` · `⬜ 待写`

---

## 一、Desktop 架构设计（`docs/develop/`）

| 状态 | 文档 | 内容要点 |
| ---- | ---- | -------- |
| ⬜ | [architecture.md](./develop/architecture.md) | monorepo 分层：`native → db → codec → service → desktop`，各 package 职责与依赖方向 |
| ⬜ | develop/ipc-trpc.md | 主进程 / 渲染进程边界：tRPC over IPC、router 组织、缓存失效约定 |
| ⬜ | develop/data-flow.md | 一条消息从加密 DB 到界面的完整链路（解密 → 取行 → 解 protobuf → domain → view） |
| ⬜ | [build-release.md](./develop/build-release.md) | 构建、打包、Tag 发版、应用内自动更新 |
| ⬜ | [platform-linux.md](./develop/platform-linux.md) | 跨平台与 Linux 移植现状 |
| ✅ | [testing.md](./develop/testing.md) | `@weq/testkit` 测试约定 |

## 二、数据库分析（`docs/database/`）

> 通用表结构指向 [QQBackup/QQDecrypt](https://qqbackup.github.io/QQDecrypt/)；
> 这里只维护 WeQ 自己 RE 出来、文档站尚未系统化的深度部分。

### `nt_msg.db` 消息体

| 状态 | 文档 | 内容要点 |
| ---- | ---- | -------- |
| ✅ | [nt_msg/index.md](./database/nt_msg/index.md) | 两列职责 + 消息段索引 |
| ✅ | [40800.md](./database/nt_msg/40800.md) | ElementWire 信封、tag 分段约定、跨类型共用字段族、容错解码 |
| ✅ | [40900.md](./database/nt_msg/40900.md) | MsgCache 字段表与递归嵌套 |

### 消息段（element）逐类型字段解析

| 状态 | elementType | 文档 |
| ---- | ----------- | ---- |
| ✅ | 1 文本 / @ | [text.md](./database/nt_msg/elements/text.md) |
| ✅ | 2 图片 | [pic.md](./database/nt_msg/elements/pic.md) |
| ✅ | 3 文件 | [file.md](./database/nt_msg/elements/file.md) |
| ✅ | 4 语音 | [ptt.md](./database/nt_msg/elements/ptt.md) |
| ✅ | 5 视频 | [video.md](./database/nt_msg/elements/video.md) |
| ✅ | 6 系统表情 | [face.md](./database/nt_msg/elements/face.md) |
| ✅ | 7 回复引用 | [reply.md](./database/nt_msg/elements/reply.md) |
| ✅ | 8 灰字提示 | [gray-tip.md](./database/nt_msg/elements/gray-tip.md) |
| ✅ | 9 红包 / 转账 | [wallet.md](./database/nt_msg/elements/wallet.md) |
| ✅ | 10 ARK 卡片 | [ark.md](./database/nt_msg/elements/ark.md) |
| ✅ | 11 商城表情 | [mface.md](./database/nt_msg/elements/mface.md) |
| ✅ | 14 Markdown | [markdown.md](./database/nt_msg/elements/markdown.md) |
| ✅ | 16 合并转发 | [multi-msg.md](./database/nt_msg/elements/multi-msg.md) |
| ✅ | 21 通话记录 | [call.md](./database/nt_msg/elements/call.md) |
| ✅ | 23 在线文件 | [online-file.md](./database/nt_msg/elements/online-file.md) |
| ✅ | 26 空间动态 | [qq-dynamic.md](./database/nt_msg/elements/qq-dynamic.md) |
| ✅ | 27 弹射表情 | [emoji-bounce.md](./database/nt_msg/elements/emoji-bounce.md) |
| ✅ | 30 在线文件夹 | [online-folder.md](./database/nt_msg/elements/online-folder.md) |
| ⬜ | 28 位置共享 | 目前只有一个文案字段（52152），暂并入 40800 总览说明 |

### 其它列 / 其它库

| 状态 | 文档 | 内容要点 |
| ---- | ---- | -------- |
| ⬜ | database/nt_msg/row.md | 消息行本身的列（40001/40003/40011/40012/40050/40800…）与「删除 / 撤回」签名 |
| ⬜ | database/nt_msg/40051.md | 会话列表外显预览（PreviewElement + tag 49093） |
| ⬜ | database/nt_msg/40062.md | 消息表情回应（贴表情） |
| ⬜ | database/nt_msg/48902.md | 未读信息块（含特别关心的嵌套结构） |
| ⬜ | database/collection.md | `collection.db` 收藏：type ↔ 子标签公式、8 种类型 |
| ⬜ | database/profile-group.md | `profile_info.db` / `group_info.db` 中 WeQ 用到的 protobuf 列 |

## 三、QQ 数据库密钥获取原理（`docs/principles/`）

| 状态 | 文档 | 内容要点 |
| ---- | ---- | -------- |
| ⬜ | [key-extraction.md](./principles/key-extraction.md) | 两条路线总览与取舍 |
| ⬜ | principles/key-nt-helper.md | nt_helper 路线（`nt_helper/src`）：原理与关键步骤 |
| ⬜ | principles/key-ninebird.md | ninebird 路线（`nt_helper/ninebird`）：原理与关键步骤 |
| ⬜ | [db-decrypt.md](./principles/db-decrypt.md) | 拿到密钥之后：文件头处理、SQLCipher 参数、`login.db` 特例 |
| ⬜ | [native-boundary.md](./principles/native-boundary.md) | native / JS 边界约定与打包坑 |

## 四、一些小巧思（`docs/principles/`）

| 状态 | 文档 | 内容要点 |
| ---- | ---- | -------- |
| ⬜ | principles/anti-recall-trigger.md | 防撤回：用 SQLite trigger 拦截 QQ 本体的撤回写入 |
| ⬜ | principles/mface-decrypt.md | 商城表情本地文件的解密（`encryptKey` / 80824） |
| ⬜ | [avatar-hash.md](./principles/avatar-hash.md) | 本地头像文件名的三重 md5 定位公式 |
| ⬜ | principles/msg-delete.md | 「删除消息」的 QQ 原生改法与可恢复设计 |

---

## 编写约定

- **只写代码里能直接看出来的东西**：字段解析以 `packages/codec/src/proto/` 的 schema 为准，
  行为描述以实际实现为准；推测性内容必须显式标注「未验证」。
- **可信度分级**：字段表统一用「置信度」列区分 `已验证` / `观测一致` / `推测`。
- **枚举可以只进文档**：解析层用不到的 QQ 原生枚举（如视频封装格式 `NTVideoType`、
  JSON 灰条业务 id `JsonGrayBusiId`）不必写进代码，直接记在对应字段文档里即可。
- 每篇文末保留返回上级的导航链接。

[← 返回文档中心](./README.md)
