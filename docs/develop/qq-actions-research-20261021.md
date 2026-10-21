# QQ 交互能力研究（2026-10-21）

本记录区分协议来源、代码接入、离线回归与真实 QQ 验收。未验证的业务语义不以命令名或模拟回包代替。

## 群分类与标签目录

### 已有依据与本轮接入

- `GetGroupJoinInfo` 复用 `0x88D_110` 群资料查询，额外请求 `GroupClassExt`（tag 8）与 `GroupClassText`（tag 18），分别映射为 `categoryId` / `categoryName`。字段未返回时保留 `null`，不默认为分类 0；不查询加群标准答案。
- 界面只展示当前群真实返回的分类，不内置未经证实的编号表，不枚举猜测服务端目录。名称缺失时展示真实编号，不编造名称。错群、读取失败或未取得编号时不启用标签写入。
- 分类写请求前重新读取当前群资料并检查编号，读取后复核账号与运行时；分类变化时不沿用旧编号。
- `0x967C/D/E_0` 的现有请求只含分类编号（以及增删时的标签名），不含目标群号。界面改称「分类标签目录」，不将其描述为对当前群 `tagRecord` 的修改。

### 仍未验收

- `GroupClassExt` 与标签目录参数的服务端兼容范围、标签 `id/type` 的具体含义、增删作用域和权限，仍需指定测试群的真实响应与客户端对照。未发送真实 QQ 写请求。
- 本轮没有宣称获取完整分类目录，也没有将标签目录增删宣称为当前群标签绑定或解绑；二者需要分别验证。
- 因此完整研究项仍保留未勾选；本轮只完成真实分类读取、去除手填与提交边界。

### 离线验证

- 协议 `group_join_info.test.ts`：5 项通过，包含分类请求字节、显式 0、缺失字段和错群响应。
- 桌面 `qq_actions_ui.test.ts` / `qq_actions_router.test.ts`：79 项通过，包含实际分类展示、未知分类禁止提交、分类变化与异步切源拦截。
- `@weq/protocol` 与桌面主进程／渲染进程类型检查通过；修改文件的 Biome 检查通过。
- 对新增分类区域做浅色 1280px、浅色 390px、深色 390px 离线截图检查，切换自定义强调色、plain / paper / grid 背景并启用减少动态效果，无横向溢出。此检查不代表真实 QQ 状态或完整桌面流程验收。

### 一手实现来源

- [Lagrange.Core 固定版本 D88DGroupInfo](https://github.com/LagrangeDev/Lagrange.Core/blob/20c2ba079b5ee67156bd71419ed54ea61a24e91f/Lagrange.Core/Internal/Packets/Service/Oidb_0x88D.cs)：tag 8、18 以及 tag 41 的 `TagRecords` 是不同字段。
- [SnowLuma 分类标签定义](https://github.com/SnowLuma/SnowLuma/blob/38fc636088b98aa35a969b2aabe240d57b04dbf0/packages/proto-defs/src/oidb-actions/group-category-tag.ts)：分类查询和增删请求无群号。
- [NapCat 群资料类型](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-core/types/group.ts)：`classExt`、`groupClassText`、`tagRecord` 分开定义。仅用作字段交叉参考，不引入其运行模块。

## 私聊动态系统卡片

- 现有 `qqDynamic` 元素已支持 JSON `jump_schema` → `mqqapi://qzoneschema` → `mqzone://arouse/detail` 的 `appid=311` 说说目标，并已有组件点击回归。
- 这不覆盖所有系统消息载荷。下一步需要定位用户所指失败卡片的具体元素类型和脱敏载荷，不能从「动态」文案或发布者 QQ 号猜测跳转目标。

## 群相册 Ark 与评论卡片

- 当前 `QqArk` 的通用外壳仅将已识别的个人空间永久链接交给 `QzoneCardNavigationContext`，并没有群相册的已确认载荷解析与导航契约；`GroupAlbumDialog` 的浏览和互动入口不能证明聊天卡片也已接通。
- 已核对仓库内 Ark 样本与生成绑定表，未找到足以确定本项群号、相册 ID、媒体 ID、动态／评论定位关系的样本。不能将个人空间的 `appid=4` 相册目标套用到群相册，也不能使用外层会话群号覆盖卡片自己的目标。
- 保留未完成。需要正常权限下的实际卡片脱敏载荷，分别核对相册卡与评论卡，补相应失败用例后再接内部浏览和互动。

## 资料卡点赞

### 协议与代码

- 两份一手实现一致：`0x7E5_104`，内层 tag 11 是目标 UID 字符串，tag 12 是来源标记 `71`，tag 13 是单次次数。不是 QQ 号／UIN 形态；沿用现有签名白名单判定，不增加 native 能力。
- `SendProfileLike` 在发包前校验 UID 和 1–20 的整数次数。1–20 取自参考实现的单次批量范围，不将其当成已验收的每日额度；不拆成多次循环请求，不自动重发。
- 既有 native 传输负责核验 OIDB 外层错误码。已核验外层且内层为空时返回 `accepted`；非空、尚未建模的内层保持 `unconfirmed`。原生业务拒绝原样上抛，不猜测未知错误码含义。
- `PeerStatsService.sendLike` 复用现有账号发包；桌面路由使用原有账号／PID 绑定与在途互斥，并拒绝给本人点赞。
- 好友资料、成员资料和个性主页共用入口；打开编辑器不发送，默认 1 次，确认提交才发包，换目标销毁编辑器，同号换来源清空次数草稿。本人、机器人或没有真实 UID 时不展示入口。
- 提交后刷新对应目标的既有累计获赞查询，不乐观加数。累计获赞查询核对响应 UID，不能把他人的统计显示在本卡片；统计刷新不提升写入的确认等级。

### 证据与未验收部分

- [SnowLuma SendLike（固定版本）](https://github.com/SnowLuma/SnowLuma/blob/db142db9e6398c779283eab9afc3552da1e2c361/packages/protocol/src/oidb-services/interaction/send-like.ts) 与 [字段定义](https://github.com/SnowLuma/SnowLuma/blob/db142db9e6398c779283eab9afc3552da1e2c361/packages/proto-defs/src/oidb-actions/base.ts)。仅借用协议事实，不引入其运行时。
- [acidify SendProfileLike](https://github.com/LagrangeDev/acidify/blob/7eac98dec2f52176180f56b2146e5e89ddc02c7e/acidify-core/src/commonMain/kotlin/org/ntqqrev/acidify/internal/service/friend/SendProfileLike.kt)：交叉确认来源标记与请求结构。
- 每日额度、会员差异、陌生人限制、实际成功响应及多端效果尚未真机验收，因此整项保持未勾选。现有 `0x7ED_12` 的累计获赞不是本发送者对该目标的剩余额度，也不是本次写入次数的权威回执。
- 真机核验应先固定正常登录账号、目标 UID 与测试对象，手动提交 1 次并检查业务回执和接收端；次数限制读取与跨端显示另记，不用自动刷赞或穷尽额度作为测试方式。

### 离线验证

- 新增协议 3 项、服务 3 项通过；桌面 QQ 操作界面／路由、三个真实挂载入口、既有资料浮层与写会话结果共 116 项通过。
- 协议、服务与桌面主进程／渲染层类型检查通过；修改文件 Biome 检查通过。未运行全量 CI。
- 弹窗以 1280px 浅色、390px 深色、320px 浅色检查，换三种强调色并启用减少动态效果；长昵称换行、次数和图标按钮均在界内，无横向溢出。截图为离线组件检查，不证明真实写入。

## 特别关心

- 现有名单来自 Qzone `specialcare_get.cgi`，是空间侧只读结果。参考客户端类型分别包含 `isSpecialCareOpen` / `isSpecialCareZone`；这证明需要区分字段，不证明两者必然独立或自动同步。
- NapCat 的 `NodeIKernelBuddyService.SetSpecialCare` 是内核接口声明，不是可直接复用的 SSO 请求／响应。当前未找到足以确认 QQ 消息侧开关的完整写入、取消和权威读回契约，不将空间名单或未读标签当作该开关值。
- [参考类型](https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-core/types/user.ts)、[内核方法声明](https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-core/services/NodeIKernelBuddyService.ts)。仍需正常客户端切换前后样本，整项保持未完成。

## 其他输入事件

- SnowLuma `SetInputStatus` 只将 `eventType` 数字透传到 `0xCD4_1`；NapCat 的设置入口示例为 1，其内核声明和入站事件同样没有停止输入／录音事件的完整枚举。
- 因此不把 0、2 等猜成停止或录音，不将“能够编码数字”当成“接收端会按指定含义显示”。当前默认关闭、主动启用且十秒节流的正在输入路径保留。
- [设置实现](https://github.com/SnowLuma/SnowLuma/blob/db142db9e6398c779283eab9afc3552da1e2c361/packages/protocol/src/oidb-services/profile/set-input-status.ts)、[NapCat 设置入口](https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-onebot/action/extends/SetInputStatus.ts)。新事件仍待真实发送与接收端对照。

## 好友免打扰

- 当前 `SetFriendDisturb` 已保留 `0x5D6_19` 根 tag 3 的原始结果项，但未建模每项 UID 与业务码；`deserialize` 始终返回 `unconfirmed`。已有本地资料读回和自动刷新不等于权威服务端映射。
- 复核独立参考后，未取得补齐该结果项的充分依据，不套用好友置顶等其他子命令的结果，不重复开发已完成的群消息四档策略。
- 仍需同一好友开／关／恢复的正常客户端样本与服务端读回；原始研究见本机免打扰专项，缺口未解决前继续保持未确认。

## 自定义状态表情

- `SetStatus.customExt` 已有 `faceId/text/faceType` 写字段，本机经典表情选择走既有 QSid；本地缓存的 `customStatus` 不能冒充远端读回。
- 当前 `GetUserOnlineStatus` 只读取 `0xFE1_2` 属性 27372 的打包状态字，只能给出基础／扩展状态，不能从扩展状态 2000 还原图标、文字或表情类型。
- 未取得完整远端自定义状态结构和跨端标识对照样本，保留现有经典表情入口，不将 Unicode、表情索引和 QSid 混用。整项仍未完成。
