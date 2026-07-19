# nt_msg.db 消息体解析（40800 / 40900）

`nt_msg.db` 的消息行中，最复杂的两列是 `40800`（消息正文）与 `40900`（消息缓存）。二者均为 protobuf，文档站仅有零散字段引用，这里由 WeQ 依据实际解析实现单独系统维护。

> 🚧 本章节为骨架结构，内容待补充。

## 两列职责

| 列    | 名称                 | 结构                              | 说明                                                   |
| ----- | -------------------- | --------------------------------- | ------------------------------------------------------ |
| 40800 | 消息正文（MsgBody）  | `repeated ElementWire`            | 一条消息的富文本消息段序列，见 [40800 解析](./40800.md) |
| 40900 | 消息缓存（MsgCache） | `repeated MsgCache`（可递归嵌套） | 转发/引用时缓存的源消息快照，见 [40900 解析](./40900.md) |

## 消息段（Element）索引

`40800` 由若干消息段（Element）组成，每段以 `elementType` 区分类型。各类型的字段解析见下：

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
| 30          | 在线文件夹            | [online-folder](./elements/online-folder.md)|

---

[← 返回数据库分析](../index.md)
