# OneBot v11 完整实现差距核查

核查日期：2026-10-29（北京时间）。这是标准与源码的静态对照及离线合成探针结果，不是完整实现、排期承诺或真实 QQ 验收。

## 结论

WeQ 适合继续建设通用 OneBot 服务，现有 QQ 协议、数据库、媒体与管理能力可以大量复用；但现有桥接不是“补几条 action 就完整”的状态。

主要工作是：标准语义层、消息与媒体转换、请求 flag 和消息 ID 的可回查登记、可靠事件源、完整通信方式及跨客户端验证。最不确定的是通知事件的完整来源，以及匿名、音乐等旧标准能力在当前 QQ 上的具体实现。

建议产品入口最终命名为「OneBot 服务」，具体客户端放在接入示例与兼容测试中。本次只记录建议，不修改名称、代码或运行配置。

## 核查依据

- 本地源码基线：`f2e689ac64ac41705af86d00e79a88ceb1267869`，核查开始时工作区干净。
- 官方标准：[botuniverse/onebot-11](https://github.com/botuniverse/onebot-11/tree/d4456ee706f9ada9c2dfde56a2bcfc69752600e4)，固定版本 `d4456ee706f9ada9c2dfde56a2bcfc69752600e4`。
- 已读取：公开/隐藏 API、API 概述、消息段、消息/通知/请求/元事件，以及 HTTP、HTTP POST、正向/反向 WebSocket、鉴权文档。
- 标准 Web 浏览工具本轮不可用，改用 HTTPS 直接读取官方 GitHub API 与固定版本 raw 文档；未以第三方实现代替标准。
- 本轮未读取真实聊天内容，未发送 QQ 消息，未重启服务，未修改运行配置，也未继续上一轮暂停的实测。

本文的「底层已有」仅表示源码中存在可复用实现，不表示每个字段、每个平台或真实 QQ 操作已经验收。

## 标准范围与当前规模

官方目录有 **38 个公开 API**，另有 `.handle_quick_operation` 隐藏 API。消息段文档有 **20 种不同的 type**；推荐好友/推荐群、普通/自定义音乐、两种 node 形态分别共用 type，不能按小标题重复计数。

事件按文档条目分为 2 类消息事件、11 类通知事件、2 类请求事件，以及生命周期和心跳两类元事件。还需进一步覆盖各自子类型。

现有 OneBot 分发器有 11 个 action 分支，其中只有 **8 个属于上述公开 API 名单**：

`send_private_msg`、`send_group_msg`、`send_msg`、`get_msg`、`get_login_info`、`get_group_info`、`get_status`、`get_version_info`。

这 8 个也不能全部按“标准兼容已完成”计数。另 3 个 `set_input_status`、`upload_group_file`、`upload_private_file` 是扩展，不属于该 38 项名单。`file` 消息段同样不属于本版本列出的 20 种标准 type。

因此不以“8 / 38”计算总工程完成率。

## 一、公开 API 逐项对照

「部分入口」表示当前桥接已有路由；「未接入」表示当前桥接未实现该标准 action。后两列是 WeQ 底层能力和仍需完成的契约，不是验收状态。

| # | 标准 API | 当前桥接 | 可复用能力与差距 |
| --- | --- | --- | --- |
| 1 | `send_private_msg` | 部分入口 | `MessageSendService` 已有发送；补全标准消息输入、布尔值转换、媒体来源、引用与临时会话上下文。 |
| 2 | `send_group_msg` | 部分入口 | 同上；群内 @、媒体、混合元素与回执需形成一致标准语义。 |
| 3 | `send_msg` | 部分入口 | 当前必须显式 `message_type=group` 才走群聊；标准允许不传该字段，仅凭 `group_id` 推断。 |
| 4 | `delete_msg` | 未接入 | `GroupModerationService.recallMessage` 已有；32 位外部 ID 必须能恢复目标、seq、clientSeq、random、时间等真实定位信息。 |
| 5 | `get_msg` | 部分入口 | 当前只读最多 4096 条内存映射，缓存内容会截断，附件正文被替换；底层 `MsgService`/DB 可以回查，但外部 ID 到原记录的登记需补齐。 |
| 6 | `get_forward_msg` | 未接入 | `ForwardMsgService` 支持本地缓存与远端 resId 拉取；需统一 forward ID、node 数组和嵌套内容。 |
| 7 | `send_like` | 未接入 | `SendProfileLike` 已有；需 QQ 号转 UID、标准默认参数，以及 accepted/unconfirmed 业务结果处理。不能只把无异常当作点赞成功。 |
| 8 | `set_group_kick` | 未接入 | `kickMember` 已有，并支持 reject；需参数和错误映射。 |
| 9 | `set_group_ban` | 未接入 | `muteMember` 已有；需默认时长、0 解除和 QQ 号/UID 映射。 |
| 10 | `set_group_anonymous_ban` | 未接入 | 未定位到标准 anonymous 对象/flag 对应的底层链路；需单独研究与当前 QQ 支持验证。 |
| 11 | `set_group_whole_ban` | 未接入 | protocol 已有 `mute-group-all.ts`；需服务适配及业务验证。 |
| 12 | `set_group_admin` | 未接入 | `setAdmin` 已有；需身份转换、默认 enable 和失败语义。 |
| 13 | `set_group_anonymous` | 未接入 | 未定位到对应实现；需核对当前 QQ 功能及协议，不假定存在可写入口。 |
| 14 | `set_group_card` | 未接入 | `setMemberCard` 已有；需空串清除和成员身份转换。 |
| 15 | `set_group_name` | 未接入 | `setName` 已有；主要是标准参数与回执适配。 |
| 16 | `set_group_leave` | 未接入 | `leaveGroup` 仅普通退群，未定位到 `is_dismiss=true` 的解散群实现；不能用退群替代解散。 |
| 17 | `set_group_special_title` | 未接入 | `setSpecialTitle` 已有；标准的 duration 本身注明效果待测试，不能承诺任意有效期。本核查不恢复已排除的头衔有效期开发任务。 |
| 18 | `set_friend_add_request` | 未接入 | `ProfileService.handleFriendRequest` 已有；需事件 flag 定位、approve、同意后 remark 等完整流程。 |
| 19 | `set_group_add_request` | 未接入 | `GroupNotifyService` 已有在线拉取和处理；需可靠 flag 登记、add/invite 区分、reason、过滤请求及原始透传字段。 |
| 20 | `get_login_info` | 已有入口 | 已返回当前账号 ID 和昵称；仍需结合账号生命周期与跨客户端验收。 |
| 21 | `get_stranger_info` | 未接入 | 本地 Profile 与 `getCloudProfile` 有基础；陌生人在线查询字段和 `no_cache` 行为需明确，不能只查本地缓存。 |
| 22 | `get_friend_list` | 未接入 | `ProfileService.listBuddies` 可复用；映射 nickname/remark，不能误用所有 profile 名单。 |
| 23 | `get_group_info` | 部分入口 | 当前只返回 ID/群名，缺成员数和群容量，忽略 `no_cache`；本地 GroupDetail 已有计数字段，在线刷新契约仍需补。 |
| 24 | `get_group_list` | 未接入 | 有当前成员身份目录与群资料；应从当前加入的群生成名单，不混入历史群，也不以部分成员缓存代替群目录。 |
| 25 | `get_group_member_info` | 未接入 | 本地成员/Profile 和在线成员分页可复用；no_cache、role、title、过期时间、可改名片等字段需逐项核实，不能随意补常量。 |
| 26 | `get_group_member_list` | 未接入 | 已有成员查询与在线分页；需读完整名单并按标准字段投影，不以默认 100 条当全量。 |
| 27 | `get_group_honor_info` | 未接入 | 现有 Web helper 仅有 4 类查询；缺 `strong_newbie`，也未提供标准 `current_talkative`/day_count 的完整结构。现有枚举注释与标准类别不能直接等同。 |
| 28 | `get_cookies` | 未接入 | `WebCredentialProvider`/`cookieHeader` 可复用；需 domain（包括缺省）的明确处理与标准返回格式。 |
| 29 | `get_csrf_token` | 未接入 | `computeBkn` 已有；需使用对应有效登录凭据。 |
| 30 | `get_credentials` | 未接入 | 可组合前两项；cookies 和 csrf_token 要来自相容凭据快照。 |
| 31 | `get_record` | 未接入 | 已有 SILK 解码至 WAV、WAV/SILK 编码；标准列出 8 种输出格式，当前不具备完整转码链，不能仅包装现有函数即称完整。 |
| 32 | `get_image` | 未接入 | 本地查找、下载与缓存可复用；需要 OneBot file 标识到具体资源的登记与回查。 |
| 33 | `can_send_image` | 未接入 | 可建立运行时能力检查；不能因存在上传函数就固定返回 true。 |
| 34 | `can_send_record` | 未接入 | 同上，需考虑当前可用编码与发送链。 |
| 35 | `get_status` | 部分入口 | 当前在线判断依赖账号记录；good 还需反映服务模块状态，不能直接与 online 永远相同。 |
| 36 | `get_version_info` | 部分入口 | 当前 app_version 是 `OneBot bridge` 占位；需返回实际应用版本，不能据此调整产品版本号。 |
| 37 | `set_restart` | 未接入 | 需要 OneBot 服务自身延迟重启机制，返回 async/1 后执行；不应顺带重启 QQ 或整个桌面应用。 |
| 38 | `clean_cache` | 未接入 | 现有存储清理能力可参考；应定义 OneBot 自己的可再生缓存，不能直接清理全部 WeQ 数据或 QQ 原件。 |

## 二、消息段差距

依据：[官方消息段类型](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/message/segment.md)。以下为不同 type 的 20 项，不将同名变体重复计数。

| type | WeQ 底层情况 | 当前桥接与待做内容 |
| --- | --- | --- |
| `text` | 收发已有 | 标准编码与字符串/数组互转仍需完善。 |
| `face` | 收发及表情目录已有 | 桥接未接；系统/动态表情应按目录选正确 wire 形式。 |
| `image` | 普通图片、闪照及上传下载已有 | 桥接仅普通图片的部分路径；缺网络 URL、已接收文件名复用、flash、cache/proxy/timeout 等标准参数。 |
| `record` | 上传与 SILK/WAV 编解码已有 | 桥接只上报可找到的语音，不发送；标准媒体来源和更广格式支持待补。 |
| `video` | 收发协议和媒体服务已有 | 桥接未接；需媒体来源、封面/尺寸与下载处理。 |
| `at` | 收发已有 | 桥接已有部分处理；需与 raw_message、UID/UIN、自身身份及 all 行为一致。 |
| `rps` | 动态/超级表情有基础 | 需明确目录和结果编码后做标准映射，不按普通 face 猜。 |
| `dice` | 同上 | 同上。 |
| `shake` | 现有 sendPoke 可参考 | 旧窗口抖动与当前戳一戳不应仅凭名称视为等价，需确认行为。 |
| `poke` | 有 sendPoke、pokeEmoji 和接收灰条 | 标准 type/id 与这些不同载体的映射未完成。 |
| `anonymous` | 未定位到发送实现 | 需验证当前 QQ 能力及 ignore 参数语义。 |
| `share` | 有 Ark/链接相关基础 | 通用 Ark 不是已验证的标准链接分享实现；需专门构建和读回字段。 |
| `contact` | 有好友/群推荐卡发送 | 两种 type 对应标准参数；接收也需还原。 |
| `location` | 有位置卡片与位置解析 | 当前位置发送响应尚未建模确认业务成功；标准 title/content 与现有 region/address 的关系需核实。 |
| `music` | 有通用 Ark，但未定位专用标准实现 | 普通平台曲目与 custom 两种形态均需专门适配和验证；旧平台类型也要逐项核当前可用性。 |
| `reply` | QQ 群 seq / 私聊 clientSeq 已有 | 桥接引用映射为进程内缓存；完整服务需可回查的外部 ID 和正确原消息信息。 |
| `forward` | 本地/远端合并转发可读取 | 桥接未上报标准 forward 段；需登记 ID 以供 get_forward_msg 使用。 |
| `node` | 发送自定义节点与嵌套转发已有 | 桥接未接；标准 ID 引用节点、custom content 和 get_forward_msg 返回节点都需转换。 |
| `xml` | 编解码已有 | 桥接未接；需标准字段与内容语义适配。 |
| `json` | Ark/JSON 编解码已有 | 桥接未接；需标准字段适配。 |

## 三、事件：最大的工程不确定项

现有桥接订阅的是 `createNtMsgDbHook` 的新消息增量，并不等于已获得 QQ 的全部实时事件。WeQ 的账号 monitor 主要处理在线/PID/会话物料，不是通用群/好友事件流。

| 标准事件 | 可复用线索 | 缺口 |
| --- | --- | --- |
| 私聊消息 | C2C 增量、临时会话识别与发送能力 | 当前一律 friend，需区分 group/other、保留上下文；完善消息与 raw_message。 |
| 群消息 | Group 增量及元素解码 | 当前固定 normal，缺 anonymous 字段，提示类未归一；补消息子类型。 |
| `group_upload` | 群文件消息、文件 token/busId | 当前只是 file 扩展段；需标准通知字段与去重，不能把任意文件占位当上传通知。 |
| `group_admin` | 成员角色与群灰条 | 尚无统一、完整的实时事件生产链；需核事件类型与设置/取消。 |
| `group_decrease` | 群灰条、成员状态 | 要区分 leave/kick/kick_me，并拿到操作者；成员名单差分不保证能恢复这些事实。 |
| `group_increase` | 群灰条、请求与成员记录 | 要区分 approve/invite 并保留操作者与真实时间。 |
| `group_ban` | grayTipGroup.muteInfo 已有 operator/target/time/duration | 是较好的结构化起点，但仍需确认覆盖、全员禁言、解除与重复提示。 |
| `friend_add` | 好友名单与申请记录 | 需要增量和真实新增事件区分，首次加载历史不能发成新好友通知。 |
| `group_recall` | 灰条解码、防撤回日志/通知 | 当前日志与设置、保护目标关联；不能当作覆盖所有会话的标准事件源。需要同一消息 ID 体系。 |
| `friend_recall` | 同上 | 同上。 |
| `notify.poke` | grayTipPoke 的 initiator/target | 可尝试直接映射，但需真实数据验证作用域、ID 与重复提示。 |
| `notify.lucky_king` | 红包消息和领取详情 | 未定位到专门、完整的通知归一化实现；查询领取记录不等于已经收到运气王事件。 |
| `notify.honor` | 群荣誉列表查询 | 列表是快照，不是荣誉变更事件；尚缺可靠事件来源。 |
| 好友请求 | 本地请求和线上处理 | 需新的请求检测、comment/flag 登记、重启后回查及处理状态。 |
| 群请求/邀请 | 在线主/过滤请求与处理接口 | 需事件生产、add/invite 映射及 flag 与原始定位字段的闭环。 |
| lifecycle | 已有 connect | HTTP POST 的 enable/disable 要随新增传输接入；标准不要求在正向 WS 推 enable/disable。 |
| heartbeat | 已有定时上报 | 需独立开关、间隔与一致状态定义。 |

现有 native 还提供捕获帧能力，但它目前用于诊断/特定功能，存在运行条件和丢帧统计，不能仅凭 API 存在就视为可交付的常驻事件总线。需先选定并验证事件来源，再决定是否扩展底层。此核查不启动抓包。

## 四、通信与通用契约

| 部分 | 当前 | 完整实现需要 |
| --- | --- | --- |
| HTTP API | 没有，当前 HTTP 只提供临时媒体 | `/:action` 与尾斜杠、GET/POST、query/form/JSON、类型转换及 HTTP 状态码。 |
| HTTP POST 事件 | 没有 OneBot 上报；已有 SSE push 是另一套 JSON 契约 | 标准事件正文、X-Self-ID、可选 HMAC-SHA1 签名、超时与响应快速操作。不能直接把 SSE 服务改名当作完成。 |
| 正向 WS | 已有通用连接 | `/api` 只处理 API、`/event` 只推事件、`/` 同时处理；合法路径、错误和 echo 行为。 |
| 反向 WS | 没有服务端桥接实现；bot 的 OneBot 客户端是另一方向 | API/Event/Universal 角色、X-Self-ID/X-Client-Role、鉴权及持续重连。 |
| 鉴权 | 仅 Bearer；错误 token 也返回 401 | 按标准处理 query token、缺失/不符状态等契约；不能只验证某个客户端会带 Header。 |
| message 输入 | 字符串/数组 | 另需单个消息段对象；递归 node 内容要一致。 |
| message 输出 | 固定数组，raw_message 仅拼文本 | 增加 string/array 配置，完成 CQ 编码和 raw_message 保真。 |
| 参数类型 | 部分直接比较 JS boolean | 标准要求字符串参数也可转成相应类型；消息段布尔值另有 yes/no、true/false、0/1 规则。 |
| 异步与限速 | 没有 | `_async`、`_rate_limited`、队列间隔、async/1、空 data、服务关闭时队列处理。 |
| 快速操作 | 没有 | HTTP POST 响应的 reply/at_sender/delete/kick/ban/approve 等；另有 `.handle_quick_operation` 隐藏 action。 |
| API 结果 | 所有异常统一 1400，部分无返回数据 action 使用 `{}` | 区分参数/不存在/业务失败/异步结果；按标准区分 null data 与有数据响应。 |
| 消息身份 | 32 位 hash + 4096 条进程内缓存 | 仍保持 int32 外部接口，但补全真实 QQ 定位、资源关联、冲突处理和账号隔离；标准未强制重启持久性，不把自主设计误称规范硬要求。 |

依据：[HTTP](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/communication/http.md)、[HTTP POST](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/communication/http-post.md)、[正向 WS](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/communication/ws.md)、[反向 WS](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/communication/ws-reverse.md)、[API 概述](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/api/README.md)。

## 五、已验证的离线反例

本轮以现有 `OneBotServer` 和合成 backend 启动回环 WS 探针，无 QQ、无模型调用，探针已结束并关闭监听。

| 输入/观察 | 现有结果 | 标准对照 |
| --- | --- | --- |
| `message={type:"text",data:{text:"synthetic"}}` | 解析被拒绝 | API 概述允许单个消息段对象。 |
| `send_msg` 只传 group_id 和 message | retcode 1400 | 标准允许根据 *_id 推断类型。 |
| `get_login_info_async` | retcode 1404 | 标准 API 概述允许 `_async` 后缀。 |
| 连接 `/api` 后生成一条合成群消息 | 仍收到 message 事件 | 标准 `/api` 是 API 专用，事件应在 `/event` 或 `/`。 |
| 合成普通群消息 | 无 anonymous 字段 | 标准普通群消息该字段为 null。 |
| 合成 @ + 文本消息的 raw_message | 只剩文本，无 CQ:at | 丢失原始消息内容，需统一 CQ 序列化。 |

这些反例证明“现有子集可连接指定客户端”与“标准兼容完成”不是同一个验收标准。本轮未修改实现来消除差异。

## 六、建议实施顺序与验收

以下是依赖顺序建议，不代表已授权开始实现：

1. **先验证事件来源和旧能力。** 为各 notice/request 找到结构化真实输入，特别确认操作者、时间、邀请类型、匿名和音乐。只在这一步之后承诺完整覆盖清单。
2. **建立通用契约层。** 统一消息/CQ 转换、参数规范化、API 登记与分发、ID/资源/请求 flag 回查；把现有特定客户端适配点改成标准语义。
3. **接入可复用 API 与媒体。** 优先名单、资料、群管理、收发和转发；单独处理 honor 字段、退群/解散、语音格式与业务回执缺口。
4. **完成全部传输。** HTTP、HTTP POST、正向/反向 WS 复用同一分发与事件模型，补快速操作、异步与限速，不在每种传输复制一套业务逻辑。
5. **按矩阵验收。** 逐 API、消息段方向、事件子类型与通信方式建立合成契约测试，使用不止一个独立客户端，再做指定对象真实 QQ 验证。不能用“返回 unsupported”替代完整功能验收。

工作量判断：名单与基本管理适配较轻；媒体与通用契约中等；完整事件闭环和旧能力研究较重，且最不确定。整体应作为较大的独立功能模块推进，不能按“38 个路由包装”估算，也不能据此承诺覆盖 NapCat 的全部扩展。

## 七、主要本地证据入口

- [当前分发/传输/ID 映射](../../apps/desktop/src/main/onebot/server.ts)，[当前账号适配与消息监听](../../apps/desktop/src/main/onebot/runtime.ts)。
- [发送服务](../../packages/service/src/account/message_send.ts)，[发送元素与媒体](../../packages/protocol/src/msg/send-elements.ts)，[转发读取](../../packages/service/src/account/forward.ts)。
- [群管理](../../packages/service/src/account/group_moderation.ts)，[全员禁言协议](../../packages/protocol/src/oidb/group-admin/mute-group-all.ts)，[退群/成员分页](../../packages/protocol/src/oidb/group-admin/group-settings.ts)。
- [好友/Profile](../../packages/service/src/account/profile.ts)，[线上资料](../../packages/protocol/src/oidb/profile/cloud-profile.ts)，[群与成员资料](../../packages/service/src/account/group_info.ts)。
- [群申请处理](../../packages/service/src/account/group_notify.ts)，[群荣誉](../../packages/service/src/account/web/group_honor.ts)，[Web 凭据](../../packages/service/src/account/web/credential.ts)。
- [数据库增量](../../packages/service/src/account/nt_msg_hook.ts)，[防撤回监听](../../packages/service/src/account/anti_recall.ts)，[灰条元素](../../packages/codec/src/element/spec.ts)，[native 捕获接口](../../packages/native/src/types.ts)。
- [语音编解码](../../apps/desktop/src/main/voice.ts)，[媒体 URL](../../packages/service/src/account/media_url.ts)，[本地文件查找](../../packages/service/src/account/file_search.ts)。

用户先前授权的真实收发实测仍保持暂停。本核查没有恢复实测，也没有修改已有服务。
