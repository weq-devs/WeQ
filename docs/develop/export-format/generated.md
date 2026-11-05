# 本地生成对话

状态：待实现设计。入口：`generated.basic.schema.json` / `generated.full.schema.json`。

| data 字段 | 必填 | 含义 |
| --- | --- | --- |
| origin | 是 | 固定 local-generated |
| targetKind / ownerId | 是 | persona/group/assistant 与对象身份 |
| sessionId | 是 | 来源会话 ID；旧版克隆 null，助手不允许 null |
| messageId / sender / role | 是 | 持久消息身份、发言者、来源角色，不伪造 QQ msgId/seq |
| sentAt / content | 是 | Time/null 与完整 Content，毫秒 ts 精确保留 |
| process | 是 | 有序 typed Value 数组，工具调用、结果、步骤、动作；空数组只代表实际无过程 |
| replyToId / mentions | 否 | 持久回复和提及关系 |

身份分量为账号+targetKind+ownerId+sessionId（null 也是独立命名空间）+messageId。
没有持久 ID 的流式回合不伪造稳定记录。message.text、steps/actions/toolsUsed 中的
真实信息都属于 basic；不能把“工具过程”只放 full。过程顺序已提供时按来源保留；
只有独立数组、没有跨数组时序时，各数组封装为带类型的 Value，不虚构全局执行顺序。

known-generated-assets 中的 voice/sticker/artifact 句柄映射到 Content 与 Resource，
生成附件内部链接不会因保存了 HTML 文件就被声称已离线化。工具结果中的路径不是
可自动下载的句柄，不据此遍历本机文件。步骤中的附件句柄只映射一次，资源文件单独复用。

full.native.attributes 默认 target=`/data`：model(text)、usage(json)、generation(json)、
sessionProperties(json)、source.<字段名>(Value)，只记录来源实际持久化的字段。
未解释步骤对象可以作为唯一 process Value 原样保留，此时 parsing 不写 complete；
若按已知字段拆过，则余项放 residual，禁止再附一份整个 step。不重新调用模型补数据。

来源：`account/generated_content.ts` / `generated_search.ts` 的 GeneratedContentSnapshot、
GeneratedMessage；`account/export/generated_export.ts` / `generated_resources.ts`。
当前 generated JSON 已有专用 schema 字符串，迁移时保留 local-generated 来源和旧会话 null，
不经普通 QQ 消息导出器。正例包含工具过程、助手附件；反例：origin=qq、助手 sessionId=null。
