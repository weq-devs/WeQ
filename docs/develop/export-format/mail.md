# 邮箱

状态：待实现设计。统一入口：`mail.schema.json`；basic/full 仅为导出内容范围。

## 基本内容字段

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| mailId | 是 | 账号内 opaque 邮件 ID，不使用 subject 或 Message-ID 充当唯一键 |
| messageId | 否 | 邮件头 Message-ID，可 null；不假定它唯一 |
| sender / to / cc / bcc | 是 | Actor 和 Actor 数组，email/name；没有实际 BCC 信息时标记覆盖不足而非猜测 |
| replyTo | 否 | Actor 或 null |
| sentAt / subject | 是 | Time 或 null；主题原文 |
| threadId / inReplyTo | 否 | 来源实际提供的会话 ID/关系，可 null |
| content | 是 | 正文 Content，原 HTML 使用 text.format=html，只保存一份原文 |
| attachments | 是 | Resource ID 数组，包含未下载/失效附件，不只列成功文件 |
| inlineResources | 否 | `{cid, resourceId}` 数组，对应原 HTML 的 cid 引用 |

身份分量为账号 + mailId。同一邮件在多文件夹列出时不重复保存正文，文件夹关系进入
full 附加属性；会话摘要不是实际子邮件，展开后逐封保留 sender、时间及附件。仅有
摘要时可保留摘要为独立内容并标记 partial，不能当作完整邮件。

当前 wire 的 emailid/messageid→mailId/messageId，senders/from、to/receivers、cc、bcc→
各 Actor；subject→subject，MailDetail.html→原 HTML 内容，attachments.id→Resource
稳定引用。MailSummary.time 当前由 timer/sendtime/fromtime/totime 选择，界面按秒使用；
新适配器须保留来源分支和映射，不能为兼容旧默认 0 而伪造发送时间。replyTo、thread
只映射实际返回关系；thread 子邮件列表不推断出来源未给的 inReplyTo。

原 HTML 是数据，不是可以直接加载的页面。查看器另行清理、限制外部请求并重写 CID，
清理结果是可重建视图，不覆盖导出数据，也不与原 HTML 重复保存为第二份权威正文。
来源本就有不同 text/plain 和 text/html 正文时可分别保存真实 MIME 表示；不能从 HTML
派生一份 plain 然后冒充来源字段。头部、MIME 原件仅在实际取得时保存，不伪造 EML。

## 全部数据属性目录

| attributes 名称 | Value 类型 | 来源 |
| --- | --- | --- |
| folderIds / labels | json | 实际目录/标签归属；不把系统目录常量当服务器观察 |
| unread / starred / draft | boolean | 邮件状态 |
| size | integer | 来源邮件字节数，不是附件合计 |
| snippet | text | 独立 digest，与正文完全相同则复用映射 |
| headers | json | 实际可得头字段；重复同名头须用有序条目数组，不能对象覆盖 |
| mimeProperties | json | 已取得的正文 part 类型、字符集、传输编码等，排除已由 content 表达的正文 |
| source.<字段名> | Value | 其他已识别邮件与文件夹缓存属性 |

附件 full Resource.native 保存 big、available、来源 ID 及其他已存附件属性，正文/附件
缺失单独结算。邮箱文件夹本身使用 resource-directory 的 folder 记录，owner 为账号；
unread/total/locked 等进入 native。未知 JSON 字段、缓存记录及 MIME 片段进入 residual。
认证 Cookie、会话票据和下载凭据不是邮件内容字段，不纳入此格式；已配置外链按原内容
保留，不将全局认证上下文转储成“全部数据”。这不排除原邮件自身真实携带的内容。

## 来源与示例

`account/mail/types.ts` 已有上述地址、目录、状态和 HTML；`wire.ts` 解析时会舍弃其他
响应字段，full 需在转换前接入残余。`client.ts` 的 read 和附件服务应复用，不重写认证。
当前 `export.ts` 把图片替为占位、删除属性后生成 body.html，message.json 又不含 html，
因此当前输出不能迁移为声称完整的原邮件。原始 MIME/完整头部当前是否可得须逐接口核验。

正例包含 HTML、CID 图片、附件、会话身份；full 增加状态与未知响应字段。反例：成功
附件无 hash/path、CID 指向不存在资源、会话摘要代替子邮件而声称 complete。
