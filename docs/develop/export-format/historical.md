# 历史兼容与统一格式

状态：2026-11-05（北京时间）补充的**待实现设计**。本次核对“梳理QQ聊天库归档流程”
会话最后的七组补充要求；原稿尚未覆盖下列实体和迁移契约，本修订补到同一套 v1 草案。
没有修改 QQ 归档服务、重新启用旧流程、读取真实历史原件或实现历史文件解码器。

## 统一的含义

历史规范化内容和 WeQ 新增导出对同一含义使用相同 data、身份、版本及来源规则。
正式内容采用 full；basic 是可按需生成的分析投影，不强制常驻另一份完整正文。
raw 原件保持原样，不以整库快照、整包 raw 或新增隐藏正文基线替代字段覆盖。
索引、阅读页面和可重建旧投影由新格式派生，不要求把所有旧投影原样搬入。

统一格式不等于一个文件：大小号、personal、shokou_private 及未知来源分区分别保留。
`archive-set.schema.json` 的 weq-export-set 清单只放归档引用、关系和共享资源引用，不放正文。
`archives[]` 必填 archiveId/path/scope，scope 与成员 archive 的 scope.partition 相同；
集合路径相对集合根，归档路径相对各自根。每个归档仍独立可读，不将 media 路径改成 `../`。
`links[]` 的 from/to 为 `{archiveId,id}`，status=verified/candidate，evidence 为非空依据定位。
候选关联不触发合并。共享资源项为 sha256/path/references，同 hash 文件可由打包器复用；
每个成员仍须满足自身资源回执，不凭集合清单声称字节已复制/校验。

## 历史字段目录

以下名称位于 full.native.attributes，target 通常为 `/data`；名称本身登记来源命名空间，
原字段路径由 observation.mappings.from 保留。每个 legacy 属性必填 interpretation：
verified 表示含义和转换有依据，partial 表示仅部分解释，opaque 表示只确认字段及类型。
未知含义但已知名字的字段不是 unknown-field，不猜含义，也不同时保存解析猜测与原值。
`legacy.schema.json` 校验登记名称、部分确定类型以及未确认状态不得标 verified。

| 名称（前缀 legacy.） | Value 类型 | 意义和映射规则 |
| --- | --- | --- |
| pcqq.header.color | integer | 旧 uint32 排版值，保留原数值，不猜颜色通道/alpha |
| pcqq.header.font_size / font_family / charset | integer | 旧头部字号、字体族、字符集各自保留；不是 NTQQ fontId |
| pcqq.header.font_name | text | 原字体名，可保留孤立码元，不另存等价 UTF-16 原字节 |
| pcqq.header.font_style | integer | 原样样式位；已能无损规范化时使用已有字段，不重复存位值及解析副本 |
| mobile.read / extensionData | 来源实际 typed Value | 含义尚未确认，interpretation 只可 partial/opaque；read 不等于对方已读 |
| mobile.reservedIntN | integer | N 为来源字段的数字后缀；保留零，不猜状态 |
| cloud.totalSeq | integer | 不与 msgSeq/客户端序号混用；当前只部分解释 |
| cloud.editable / msgEventInfo | 来源实际 typed Value | 当前只可 partial/opaque，不伪造可编辑或事件语义 |
| senderSnapshot.memberLevel / gender | 来源实际 typed Value | 记录时点的发送者资料，不能用今天目录资料替换；原枚举不猜文字解释 |
| qzone.classid / className | 来源实际 typed Value / text | 相册分类 ID、原分类名；不把分类 ID 当相册 ID |
| qzone.lastuploadtime / modifytime | 来源实际 typed Value | 相册最后上传、修改字段；解释单位前保存唯一原值，解释后改用规范 Time 属性，不双存 |
| qzone.shootGeo / lbs | 来源实际 typed Value | 只有尚未被 data.location 表达的附加部分；未知叶转 residual |
| collection.bizKey / qzoneUgcKey | text | QQ 收藏附加关联键，不代替 CID，不自动归并为同一空间对象 |
| collection.topTime | integer | 旧样本 0 仅保存为 0，不据此宣称有实际置顶历史或已知时间单位 |

PCQQ color/font_size/font_style/charset/font_family 的整数类型和 font_name 文本依据本机
ChatsArchiveTools 的 `scripts/pcqq_msg0_decode.py` 头部定义复核；其余表格按前一会话
最后的字段核验结果承接，本轮未重读真实资料或重新证明这些字段的业务意义。
未固定类型的条目不是免验：提取器必须登记其实际源类型及转换规则，不以 json 容器代替
已知字段目录。今后新增已知属性先补目录/schema/夹具；本轮枚举不冒称穷尽全部历史列。
普通消息的类型、状态、反应等已有语义字段不改名为 legacy，不当作 WeQ 解析盲区。

## 空间内容与关系

| 历史对象/字段 | basic 中的权威表示 | full 额外内容 |
| --- | --- | --- |
| 日志 | type=blog；title、完整 content，原 HTML 用 text/format=html | 未进入正文的原属性与残余 |
| 留言板 | 每条留言 type=guestbook，HTML/UBB 正文；replyList 拆 reply，指向留言 | 其他留言与回复属性 |
| 分享 | type=share；structured/link 保留原链接和来源，评论独立记录 | 详细互动属性 |
| 空间收藏 | type=favorite，必填 targetId，跨类型被收藏对象单独存 | 收藏附加属性；不是 QQ collection |
| 访问 | 每次 type=visit，author 是访客，owner 是空间主人，createdAt 是访问时刻 | 该访问事件原属性；不是访问量 counts |
| 照片拍摄/上传 | shootTime→shotAt，uploadTime→uploadedAt，createdAt 未知可 null；位置用 location | 未映射 shootGeo/lbs 片段 |
| 照片/相册互动 | comment/reply.parentId 指向实际对象，历史导入必填 parentType | likes 位于该对象自己的 native，不能挂到同名说说 |

日志全文与原 HTML 若是同一内容的解析/渲染表示，只保留原 HTML 一个权威正文，不再保存
去标签文本；来源独立提供且内容不同的正文/摘要则按不同语义保留。互动计数不造名单，
相同访客重复访问不能按昵称和时间合并。没有来源 ID 的空间条目同样分配持久本地 ID，
sourceId 仅为来源局部定位，不冒充服务端 ID，identity.status=source-local/unverified。

## 身份与来源

Record.id 是归档稳定键，data.messageId 是原生消息 ID，可 null，seq 同样可 null。
历史导入必填 identity.status；messageId 非 null 时必填 identity.nativeNamespace，如
pcqq/msg0、ios/message、android/message、ntqq/message、qq-cloud/message。仅命名空间
也不足以跨来源合并，仍需可信账号、会话和原生身份对照。原生 ID 相同、正文相同、昵称
相同均不是归并证据。未知会话用 `{kind:"unknown",id:null}`；未知账号用 identities=[]，
scope.partition 仍须唯一保留该来源分区，不创造 QQ 服务器账号/会话。

Observation 的新增字段均不带已知正文：

| 字段 | 必填性与意义 |
| --- | --- |
| source.id | 已有必填字段；保留原 source_id 的来源命名空间，不挪作作者身份 |
| source.provenance | legacy-import 必填；可含 file/table/row，或 chunk/line，已有 sha256；保留真实存在的定位字段，不编造行号/校验和 |
| provenance.sourceAccount / observerAccount | 可选 Actor；源账号、采集/观察账号与 record.data.sender/author 分开 |
| provenance.scope | 可选来源分区；提供时须与 archive.scope.partition 一致 |
| importedAt | legacy-import 必填；本次迁移时刻，不修改旧 observedAt |
| observedAt | 必填但可 null；当年采集时间缺失为 null，不用迁移当天代填 |
| legacyReferences[] | namespace + messageId，variantId 可选；分别映射 archive_message_id/archive_variant_id，引用当前 recordId/revision |
| identityLinks[] | relation=same-object/actor-alias/display-alias、target、status=verified/candidate、evidence；仅展示别名不赋予身份合并能力 |

target 是带命名空间的稳定关系目标或归档对象 ID；跨归档对象关系用集合 links，包含
archiveId，不把外部 ID 当当前归档内 ID。evidence 指向已有来源定位或核验记录；候选不
升级为 verified。旧变体对应不同 revision，多个原引用对应相同新版时保留多个观察引用。
未知时区时间存 Time.local/timezone=unknown，保留原串与精度，不编造 unixSeconds。
字符串原样保存 code units，孤立 UTF-16 码元在 UTF-8 JSON/JSONL 中转义为 `\uXXXX`。
二进制和不安全整数继续沿用 bytes/base64 与十进制字符串，不经有损 Number 转换。

## 资源与派生

资源的 saved 只证明该回执的文件保存状态，不证明它属于某条消息。
可选 `bindings[]` 的每项必填 recordId、target（内容元素的 JSON Pointer）、status
（verified/candidate/unresolved）、evidence；目标元素必须引用该资源。不同消息可以
对同一已保存文件具有不同绑定状态，不会因为校验和相同而全体升级为 verified。
旧归档没有绑定证据时明确 unresolved；新格式保存的确定引用才用 verified。

播放副本使用 role=playback，必填 derivation：sourceResourceId、operation、inputCodec、
outputCodec、evidence，inputSha256 可选。有输入 hash 时须对应原件已保存回执，不允许
悬空、自引用或循环。SILK→WAV 是典型实例；转码成功不证明原始消息绑定成功。
观测时间未知的旧资源也可 observedAt=null，但须 importedAt，不拿迁移时间代替原观察。

TAR/CAS 位置放 full Resource.source.locator/provenance：container=file/tar/cas、member、
offset、length 等，不当成可直接打开的 media 路径。正式 saved path 仍为 media/sha256，
须实际提取并核字节后才写 saved。full→basic 保留绑定/派生关系及其依赖原件回执；
native-only 的未引用变体才可在投影中省略。没有复制文件不等于格式不能表达该资源。

## 对照与验收

| 最后要求 | 本次落点 | 尚待实现 |
| --- | --- | --- |
| 旧已知字段、解释状态及当时资料快照 | legacy.schema、native 属性目录及合成字段映射 | 实际各源提取与字段清单 |
| 日志/留言/分享/空间收藏/逐次访问 | qzone.schema 共用 data 与独立身份 | 历史迁移、在线采集分别实施 |
| 拍摄/上传/地点、正确互动父实体、收藏关联键 | shotAt/uploadedAt/location/parentType、legacy 属性 | 来源单位/坐标/枚举核验 |
| 跨年代 ID、未知账号会话、旧引用/别名、分区 | identity、nullable messageId、legacyReferences、identityLinks、archive set | 可信身份归并与旧映射导入 |
| 来源行/chunk、hash、账号角色、时间/编码无损 | provenance、importedAt/nullable observedAt、Time.local、转义码元 | 对真实输入逐字段对账 |
| 附件候选、播放副本、TAR/CAS 来源 | bindings、derivation、provenance | 资源提取、真实转码及字节核验 |
| 不以通用 JSON 通过代替完整 | 以下逐字段验收，黄金夹具与预期失败反例 | 真实全量来源验收 |

迁移前为每一输入字段/片段生成覆盖账目：来源命名空间、字段路径、源类型、解释状态、
目标 Pointer、转换规则、归档/版本/观察引用、资源关联。每个片段恰好落入一种去向：
已存在语义字段、已登记来源附加属性、未知残余，或有具体规则可重建的派生/编码包装。
未归类字段为失败项；宽泛 Value/json 能装下整行不等于字段覆盖通过。输出逐项核对
数值、code units、字节和关系，不以记录总数或目标 schema 通过替代。

本轮合成正反例在 `historical-fixtures.mjs` 与 `contract.test.mjs`，验证 full/basic、
JSON/JSONL、旧引用、未知身份、字段类型、时间、父对象、资源绑定与集合引用。
它们证明目标契约可表达且检查能拒绝特定错误，不证明旧解码器/真实历史已经无损迁移。
现存 raw、唯一来源信息与旧版本不删除；业务接入、迁移执行及实际验收分别记录。
