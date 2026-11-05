# 消息与频道

状态：待实现设计。入口：`message.basic.schema.json` / `message.full.schema.json`。
共同外壳及类型见 [common](common.md)。以下均指 Record.data。

## 基本内容字段

| 字段 | 必填 | 类型与含义、来源 |
| --- | --- | --- |
| conversation | 是 | Conversation；私聊 40021/targetUid，群 targetGroupCode，频道 40027/nodeId；kind 来自实际迭代器 |
| messageId | 是 | 40001/msgId 字符串；不可用 seq 替代 |
| sender | 是 | 40020/senderUid、40033/senderUin；频道 40026/senderTinyId；namespace 不混同 |
| sentAt | 是 | 40050/sendTime 秒 → Time 或 null |
| seq | 是 | 40003/msgSeq 十进制字符串或 null，不把 0 当未知 |
| content | 是 | 40800 的有序 Content；forward.ts/本地40900 提供嵌套节点，不能从展示文本反推 |

普通消息身份分量为账号、conversation.kind/id、messageId。漫游和本地有同一可信消息
身份时合并为来源观察；精确选择仍保留读取来源约束，不用它制造重复的业务消息。频道的
tinyId 不是 UIN；guildId/directGid 等通过附加属性保存，不猜测 QQ 身份对应。

## 全部数据属性目录

除 data 外，full.native 必填。以下属性放在 attributes，target=`/data`，除非另注。
Value 类型必须遵循目录；尚未登记、但来源已识别的属性以 `source.<原字段名>` 命名，
登记其来源和类型，不能伪装成 unknown。目录不是允许丢弃其他列的白名单。

| 规范名 | Value 类型 | 来源/映射 |
| --- | --- | --- |
| msgRandom / clientSeq | integer | 40002 / 40005，不能与 msgId/msgSeq 混同 |
| chatType / msgType / subMsgType | integer | 40010 / 40011 / 40012，保留原枚举数值；名称由读者查表 |
| sendType / sendStatus | integer | 40013 / 40041 |
| routing | json | 40021/40030 等中尚未被 conversation、sender 表达的路由信息；相同身份只保留映射 |
| decoration | json | 40801 解析后的气泡/字体/挂件；未知 tag 残余单列 |
| reactions | json | 40062 贴表情；保留零/空的真实值，不用展示过滤结果代替源值 |
| directGid / guildId / peerTinyId | text/integer/integer | 频道会话缓存路由与身份 |
| element.<规范名> | Value | target 指向具体 content 元素或 forward 节点；如 urlVerifyFlag(bytes)、subType(integer)、fileToken(text)、hash(text/bytes) |

SELECT 列之外的全部其他列仍须枚举。已知元素未进入渲染层的属性从 codec/来源提取；
未识别 SQL 列、protobuf tag、类型冲突、sanitizer 丢弃值、未消费尾字节进入 residual。
同一元素中已映射的文本不能再附整个 40800。Ark JSON/XML 若作为唯一 structured/text
内容保留，就不再将原串作为附加 raw 字段。线上取回和 40900 本地转发缓存都要沿用
ForwardMsgService 的实际取图/取转发链路，不在新 schema 里另造下载器。

## 内容与状态

回复保留目标消息的稳定定位和来源引用文案，不能只导出“回复某人”。文件、在线文件夹、
表情、内联键盘、通话、红包、系统灰条等都走 Content，不限于可显示文本。合并转发和
结构化长消息保留内部发送者、时间、seq、顺序及资源引用；取不到时保留卡片和 unavailable。
撤回/删除证据触发 deleted 版本，旧版正文仍留存。不能仅靠未见本地行认定已删除。

## 来源与示例

- 当前 `packages/service/src/account/export/types.ts` 只保留 msgId/msgSeq/sendTime、
  senderUin/senderUid、RenderElement 和可选 decoration，不能作为 full 的输入。
- `packages/db/src/msg/types.ts` 已有部分行属性；`packages/codec/src/domain/msg/row_to_message.ts`
  与 `packages/codec/src/raw/` 可用于核对字段，但当前 sanitize/decode 容错会丢弃内容，需补接残余提取。
- `packages/db/src/guild/types.ts` / `account/export/guild_source.ts` 提供频道专用字段与迭代，
  不套普通私聊的 SQL 身份。

正例见 examples/basic.json 的 message、guild-direct 与嵌套 forward；full.json 展示 clientSeq、
嵌套未知 tag 和尾字节。反例：seq 为不安全 JSON 数字、未知字段和已知映射重叠、forward
节点缺 sender 均在规范测试中拒绝。
