# 共用数据契约

状态：待实现设计。schema 是形状约束，跨记录语义由[验证工具](validation.md)及实现共同检查。

## 归档封装

JSON 根对象对应 `archive.schema.json`。必填字段如下。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| format / version | 标识 / 版本 | 当前写入 `weq-export` / `1.0`；独立于应用版本，同主版本的小版本读取规则见下文 |
| profile | basic 或 full | 首次导出的内容范围选项，仅为说明，不用于格式分派，不限制后续记录含哪些附加字段 |
| archiveId | 非空字符串 | 首次创建后保持不变，不用每轮任务 ID 替换 |
| scope.account / partition | Actor / 可选字符串 | 来源账号与来源分区；账号未知时 partition 必填，不同账号或 scope 不因消息 ID 相同而混写 |
| scope.selection | Value | 首次选择的描述，精确 ID 集合不退化成日期近似范围 |
| formats | JSON/JSONL 数组 | 显式选择的结构化格式，不含强制附加的隐藏副本 |
| incremental | 对象 | `enabled`；开启时必填唯一 `authority`，必须属于 formats |
| records | Record[] | 各对象的不同内容版本，只出现一次 |
| observations | Observation[] | 来源和本次观察，不重复携带正文；数组顺序属于正式语义 |
| resources | Resource[] | 各次资源取得回执，不内嵌文件字节 |
| externalReferences | 可选数组 | 范围外父对象等的 id/kind/reason（not-selected/unavailable），不附其正文 |

若同时选择 JSON 与 JSONL，默认 JSONL 为 authority，JSON 是显式要求的可重建快照。
只选 JSON 时 JSON 为 authority。两者不独立合并、不相互当隐藏基线；派生快照标明取自
哪个提交点（旁附可重建视图索引即可）。解析结果以 authority 的已提交状态为准。

## Record

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| id / kind | 是 | 归档内稳定对象键及领域，id 不随范围、格式、下载路径改变 |
| revision | 是 | 小写 SHA-256，算法见下文 |
| state | 是 | present 或 deleted；deleted 只在确有删除/撤回证据时写入 |
| coverage | 是 | acquisition：complete-for-selection / partial / unknown；parsing：complete / partial / opaque |
| data | 是 | 对应领域的完整语义内容，basic/full 共用，不是两套结构 |
| native | 否 | 已取得的附加属性与未知残余；存在时 attributes/residuals 数组必填，允许为空；读取不由 profile 决定是否接受 |
| identity | 历史导入必填 | status=verified/source-local/unverified；原生消息 ID 非 null 时 nativeNamespace 必填，不能把归档 id 当原生 ID |

对象键用 `namespace + 身份分量` 表示，分量采用 JSON 数组编码后计算 SHA-256，前缀为
领域名，如 `message:<hash>`。输入包括账号身份、领域、会话/父对象身份和来源稳定 ID。
字段内的 messageId、CID 等仍保留原值供分析。账号 identity 以固定 namespace/value
为准，不能用昵称；没有可证实的 UIN/UID 对照就保留独立身份并记录关联候选，不合并。
无服务端 ID 的转发节点以资源 ID + 节点稳定索引定位；完全没有稳定身份的记录使用
持久分配的本地 ID，记录 identity-unverified，不声称跨来源可去重。修改正文不改变 id。

`revision = sha256(UTF8(C(Record 去掉 revision 属性)))`，包括读取者不认识的新增可选属性。
当前 1.0 Record 的其余属性就是 id/kind/state/coverage/data/identity?/native?，既有摘要不变。
`C` 递归按对象键的 UTF-16 code unit 升序**直接输出成员**，数组保序，无空白。
键和标量用 ECMAScript `JSON.stringify` 编码，不能先创建排序后的 JS 对象再整体 stringify，
否则整数键会被重新按数值排序。例如 `{"2":"b","10":"a"}` 的 C 必须为
`{"10":"a","2":"b"}`。数值采用 ECMAScript 的最短 JSON 表示；非 JS 实现须通过同一
黄金向量。只允许有效 JSON、有限数值；字符串不做 Unicode 归一化。
整数超出安全范围先转为字符串；字节用 Value。协议不接受重复 JSON 键或负零数值。
观察时刻、来源位置、下载状态不进入正文版本摘要；它们分别属于 observations/resources。
full 向 basic 投影删除 native、重算摘要，并合并投影后相同的版本及来源观察引用。
对象 id 不变；投影是显式生成的派生内容，不是对原 full 的删除更新，不强制更换 archiveId。

## 基础类型

| 类型 | 表示与规则 |
| --- | --- |
| ID / seq / 大整数 | ID 为非空字符串；整数为无前导零的十进制字符串，seq 允许 0 和负占位值，不猜成有效服务端序号 |
| Time | `{unixSeconds: "1793856000.125", precision: "millisecond"}`；秒为十进制字符串，最多九位小数，不先经浮点数截断 |
| 时间精度 | second / millisecond / microsecond / nanosecond；小数位不得超过声明精度，不补出来源没有的精度 |
| 无时区时间 | `{local:"2008-07-01 20:30",timezone:"unknown",precision:"unknown"}`；日期可 precision=day；保留原串，不与 unixSeconds 混装 |
| 未知时间 | `null`，原始不可解释值放 full residual；无时区原串不转换为假 UTC |
| Actor | identities 数组，namespace 区分 qq-uin、qq-uid、guild-tiny、email、local、source；name 可选 |
| 空身份 | identities 可为空，仅表示未知；有名字不等于有可合并身份 |
| 缺项 | 属性缺席为未提供/不适用；显式 null 为已知未知值；0、false、空字符串不得互相替代 |
| 枚举 | 领域枚举由 schema 约束；未识别来源枚举不强套已知含义，full 保留原数值 |
| Value | `{type, value, encoding?}`；integer 使用字符串，bytes 使用规范带 padding base64，encoding=base64 |
| JSON Value | 仅安全整数及有限浮点；含大整数/二进制时拆为 typed Value，不能让 JSON.parse 先丢精度；孤立 UTF-16 码元须按 `\uXXXX` 转义，不替换为 U+FFFD |
| 路径 | 包内相对路径，`/` 分隔；禁止绝对路径、盘符、`.`/`..`、反斜线、控制字符和 URL 编码路径 |

查看器显示时间使用北京时间，但数据不重复保存本地格式化时间。路径在使用前还须核实真实
文件位于归档根内，不通过符号链接逃出；schema 的字符串检查不能替代文件系统校验。

## 内容元素

`content` 为有序元素数组，顺序是正文的一部分。写入 schema 中各元素均是闭合对象；
兼容读取允许其未知可选属性，但仍校验已有 type、必填字段与类型，不猜测未知元素类型。

| type | 必填属性 | 用法 |
| --- | --- | --- |
| text | text | format 可为 plain/html/markdown/xml，缺省 plain；保留原正文而非清理后的展示副本 |
| mention | actor | all 可标识 @全体，不靠显示名猜对象 |
| media | mediaType、resourceIds | image/audio/video/file/sticker/live-photo；可含 caption、durationSeconds |
| reference | target、status | 回复、复用转发子树；resolved/unavailable/cycle/depth-limited，quote 只保存来源实际独立引用文案 |
| forward | status、records | 内部节点含 id、sender、sentAt、seq、content，支持再次 forward；卡片资源 ID 可选 |
| structured | kind、value | 链接、位置、Ark、表情、红包、通话、系统事件、内联键盘等的完整语义载荷 |
| unknown | sourceType、reason | 明确内容不可解析；basic 不带不透明原始载荷，full residual 保留它 |

structured.value 是该内容的权威表示，不得再保存同一 JSON 字符串的解析副本。仍未充分
理解的内容可以保留 source-native kind 的原始 text/bytes Value；此时它本身就是唯一
正文，parsing=opaque/partial，不再把同一字节放 residual。解析器认得部分字段时，已知
部分进入元素，其余进 residual。通用 Value 不能代替应有的字段映射或证明解析完整。

嵌套节点必须保持身份和原顺序。重复引用同一转发资源时以 reference 复用已保存节点；
真实重复发言不是重复资源，不能按正文相同删除。深度/资源循环限制必须产生显式状态，
不得截断后写 complete。顶层与嵌套记录引用可用 archive id 或本记录内节点 id。

## 全量附加数据与来源

`native.attributes[]` 保存已识别但不属于 basic 的属性：`target` 是本记录 JSON Pointer，
`name` 是文档登记的规范字段名，`value` 是 typed Value。target 根为整个 Record；
例如 `/data` + clientSeq，`/data/content/0` + urlVerifyFlag。不得把 senderUin 或
原始 40001 复制进 attributes，因为它们已有 data 表示。相同 target/name 只出现一次。
已知结构的 JSON 属性只存一份命名结构值，不同时拆出重复的子字段。

`native.residuals[]` 必含 source、path、reason、value；source 指向同版本 observation
的 source.id。path 使用来源字段树的 JSON Pointer（SQL 列、protobuf tag 和 occurrence
分别成段，例如 `/40800/45001/0/99999/0`），禁止模糊字段名。可附 wireType、字节 offset、
length 和 occurrence；已知 tag 的错误 wire type 仍属于残余。未消费尾字节必须保留，
不能因为 protobuf walker 提前结束而把它当 padding 丢弃。

每个来源最小值片段恰好属于一种情况：映射到规范字段、作为 residual 原样保留、或确认
无额外信息的编码包装。最后一种也要在提取器的覆盖清单说明；不得笼统略过“技术字段”。
部分解析时不得再附整个父 BLOB；只有整个对象未解析、且未发布其已解析字段时才存完整
不透明载荷。不能确定如何拆分时先保存唯一不透明表示并标记 opaque，而非冒称完整解析。

Observation 必含 id、recordId、revision、observedAt、source；历史 observedAt 可 null，
legacy-import 必填 importedAt，不能拿迁移时间冒充当年观察时间。source 含稳定 id、kind、
逻辑 locator，可含 modifiedAt。逻辑位置如 `nt_msg.db/group_msg_table`，不是运行机
绝对路径。full 的 mappings 记录 `from` 来源叶路径、`to` 本记录 Pointer、`transform`
规则名（如 unix-ms-to-seconds-v1），不携带原值。完整映射清单应覆盖本次消费的来源叶。
同一来源叶只映射一个权威目标；需要拆出多个语义字段时映射到承载这些字段的公共结构，
不能另保留一份原值。投影 basic 时，删除只由 native 引用的额外资源变体回执。
Observation.profile 可记录本次扫描选择 basic/full；新扫描应写入，旧观察缺席时表示未记录，
不能从 header.profile 推断之后每次扫描的选项。它不参与正文摘要，也不证明来源取得完整。
多来源相同内容复用 Record；来源有分歧时各自绑定自己的版本，不能把两个互斥值拍成一个。
Observation.selection 可记录本次实际读取选择；扩展/更换范围时必须提供，旧 header 的
首次选择不改写。精确选择不包含父对象时，用 externalReferences 声明范围外关系而不扩读。

## 资源回执

Resource 必含 id、role、status、observedAt；name/mime/url/size/尺寸可选。role 区分
original、preview、thumbnail、cover、unverified、auxiliary、playback。status=saved 时必须含
path、sha256、size；其他状态不得含成功路径或下载摘要，可含失败原因。size 是字节数。
资源可附 native 和 source（Source），两者同时存在或同时缺席，规则同正文；残余来源指向
该 source.id。是否存在这些字段不由 header.profile 限制。
URL 是线索，不代表已取得资源。

resource id 以来源稳定引用和变体角色生成；文件按内容 SHA-256 放入 `media/<sha256>`，
不依赖扩展名。不同 URL 内容相同可共用 path；不同原图、预览、封面及视频不可因 URL
相似而合并。缺失引用也必须有 not-requested/missing 等回执，不能静默消失。回执可追加，
已有成功文件不被之后的失败观察覆盖；读取最新成功回执并单独展示最新尝试状态。

历史来源定位、旧 ID 映射、身份关联、附件绑定 bindings 与派生 derivation 的字段定义及
验收见 [历史兼容契约](historical.md)。bindings 状态独立于 saved；playback 必须有派生
来源、编解码信息及依据。TAR/CAS 的位置只能进入来源 locator/provenance，不是 media path。

## 新增字段与兼容读取

正式 writer 按其目标版本的闭合 schema 校验，新字段先登记对应版本的 schema、字段说明
和测试，不能靠 reader 宽容读取偷偷发布。reader 则允许已有业务对象增加可选属性，保留
原始结构，只解释已知字段；不能将未知属性中的 type/resourceIds/unixSeconds 等名字猜成
已知内容、引用或时间。必填字段、已有字段类型、枚举、native 的内部结构等约束仍成立。
`native.attributes/residuals` 保存来源属性；它们不替代格式本身新增可选字段的兼容读取。

JSON 读取和 JSONL 解码返回的正式对象不得按展示模型重建。未知属性（包括 Record 根、
data、内容元素、Observation、Resource、header 和集合成员的属性）必须在无损转换、
校验摘要及增量重写时保留；未知 Record 属性参与 revision，未知内容行载荷参与批次摘要。
header 原样保留，不把文件版本号降成当前 writer 的版本。JSONL 的 type/batchId/commit
外壳及提交算法在同一主版本固定，不允许通过新增行类型或提交字段绕过旧 reader 的校验。

`observations` 在 JSON 中按正式追加顺序排列；JSONL 按已提交 observation 行顺序恢复。
迁移、转换、投影和重写不得排序这个数组。按时间的排序只能用于派生视图；观察时间相同
或不可排序时使用该稳定顺序。resources 回执数组同样保持追加顺序，时间相同时用顺序
确定最新成功与最新尝试；records 不靠排列顺序决定新旧。

## 一种格式，两种导出范围

basic/full 只是导出时的内容范围选择，共用 format/version、归档封装、领域 schema、对象
身份、摘要、资源和增量协议。每个领域只有 `<领域>.schema.json` 一个入口，reader 依据
实际字段读取，不依据 profile 选择另一套解析器。profile=full 不是来源/解析覆盖完整的证明。

basic 输出完整语义内容；full 复用相同内容提取，再枚举所选来源的全部其他字段，保存已取得
的 native、映射和来源信息。schema 允许 native 缺席，不代表 full 可以跳过字段枚举或漏存
已取得的属性：取得失败或解析缺项仍须标 partial/unknown/opaque，不能补空 native 冒称完整。

同一归档允许只有基本内容的旧版本与带附加数据的新版本共存。后续 full 读取真实来源后以
相同 id 追加新 revision/observation；后续 basic 不删除旧 native、不把旧 full 改写成 basic。
header.profile 保留首次选择，新增 observation.profile 说明当次选择，不需要格式迁移、
第二份正文基线或仅因选项变化而新建归档。
