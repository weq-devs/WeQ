# 群内单成员消息提醒研究

更新：2026-11-11（北京时间）。**当前状态：功能已按要求暂时撤下，仅保留研究与实测记录。**

Android QQ 的设置界面、写入命令与字段已静态闭环，但当前 macOS QQ 登录态的真实读取未返回完整有效状态。不能把静态协议或离线测试通过写成当前账号可用，也不能把缺失字段补成“默认”再开放保存。

## 当前源码状态

实验接入提交为 `7cc727484a223461506781bce2a7293c09ab15f3`。随后撤下群成员名片及头像右键入口、专用 hook／样式、IPC 读取／修改路由、群资料服务接线和专用协议／测试夹具。用户文档不再将其列为可用功能。

下文中的 `GroupMemberNotifyMode`、`getGroupMemberNotify / setGroupMemberNotify`、`GroupMemberNotifyService`、`groupMemberNotifyState / groupMemberNotify` 均指该实验提交中的历史实现，不是当前导出接口。需要恢复时可从该提交查看原实现，不依赖已删除的工作区文件。

通用 legacy OIDB 的可选 `allowEmptyBody` 已被资料互动及照片上传复用，因此保留，并将回归用例独立为 `packages/protocol/test/legacy_oidb_ack.test.ts`；这不表示群成员提醒仍然开放。

## 研究依据与语义

样本为 Android QQ **9.3.75.42350**，不是当日最新版本声明。限定核查 33 个类、8 份原 DEX；复核来源长度／SHA-256／CRC，从静态初始化器恢复 10 个 protobuf FieldMap、21 个字段。未取得官方公开协议说明，结论依据为该样本的实际代码。

研究对象是“当前账号在某个群内对某位成员的个人消息提醒设置”，不是整群免打扰、管理员禁言、好友特别关心或 WeQ 本地关键词提醒。

| 页面语义 | UI 状态 | SSO | OIDB serviceType | GroupConcernedInfo 本次字段 |
| --- | ---: | --- | ---: | --- |
| 默认 | 0 | OidbSvc.0x8bb_9 | 9 | 6 repeated uint64 UIN |
| 群内特别关注 | 1 | OidbSvc.0x8bb_2 | 2 | 3 repeated UinInfo，子字段 1 UIN |
| 屏蔽该成员 | 2 | OidbSvc.0x8bb_7 | 7 | 5 repeated ForbidUin，子字段 1 UIN |

三者 command=**0x8bb（2235）**，群号为 GroupConcernedInfo tag 1，成员为数值 QQ 号而不是 `u_` UID。默认是独立 SET_DEFAULT 操作，不能用“关注=false”、空关注列表或随便选一个删除子命令代替。中文按语义归纳，三个 radio 的资源 ID 为 `0x7f1236a2 / 0x7f1236dc / 0x7f1236d4`，未提取资源表，不称逐字原文。

### Android 调用与保存响应

`membersetting.part.bb`（MemberSettingGroupManagePart）打开三项 ActionSheet；`part.ay.onClick` 将选项位置映射为 0／1／2，经 `MemberSettingGroupManagePart$onMsgTipEntryClick$2$1 → vm.b$h → MemberSettingViewModel.handleIntent → MemberSettingHandler.S2` 构造单目标请求。S2 支持 UIN 列表，页面实际只传单个目标；列表结构不证明服务端批量上限。

handler 要求 FromServiceMsg resultCode=1000、OIDB 可解析且 result 存在并等于 0。非零 65／66 有不同 UI 失败分发，但其准确文案、配额与上限未核。成功后根据请求 extraData 和命令推导三态，调用 `saveTroopMemberSpearkFlag` 更新本地再通知 UI；该分支没有立即独立读回服务器，也没有从 WriteRsp 逐成员确认持久化。

Android Servlet 的 protobuf 分支会处理 service 层四字节前缀，不应在 WeQ 已处理过前缀的响应上再处理一次。不能把命令替换成 `OidbSvcTrpcTcp`；实际签名需求仍未确认，不登记成已实测不签名。

### 已确认的 protobuf

| 结构 | 字段 |
| --- | --- |
| ReqBody | **1 msg_write_req:WriteReq；2 msg_read_req:ReadReq** |
| RspBody | **1 msg_write_rsp:WriteRsp；2 msg_read_rsp:ReadRsp** |
| WriteReq / WriteRsp / ReadReq / ReadRsp | 1 repeated GroupConcernedInfo |
| GroupConcernedInfo | 1 group_code:uint64；2 update_time:uint32；3 concerned:UinInfo[]；4 word:WordInfo[]；5 forbid_uins:ForbidUin[]；6 default_uins:repeated uint64 |
| UinInfo | 1 uin:uint64；2 update_time:uint32；3 from:uint32 |
| ForbidUin | 1 uin:uint64；2 update_time:uint32 |
| WordInfo | 1 keyword:string；2 update_time:uint32 |

首次校验曾错误预设“读 1 写 2”，断言失败后回到生成类常量及 FieldMap 核实，修正为“写 1 读 2”。这是研究校验修正，不是服务端失败。上述数值为 wire 0，嵌套 message／string 为 wire 2。

写请求形状为 `ReqBody{1: WriteReq{1: [GroupConcernedInfo{...}]}}`，每次只发群号与表中目标字段。Android 此调用不设置 update_time、from 或关键词；时间单位与 from 枚举未核，不能因为生成类默认 0 就额外发送。

## 读取依据与未闭环候选

单成员 SSO 为 `group_member_card.get_group_member_card_info`，Android `TroopMemberCardHandler.Z` 请求 protobuf：1 groupCode:uint64、2 uin:uint64、3 newClient=true、4 clientType=1、5 richCardVersion=1。

响应 tag 1 是群号、tag 3 是 MemberInfo；成员内 1 UIN、2 result、3 错误文本、30 concern_type。Android T2 将 0／1／2 分别映射为默认／关注／屏蔽，写入 `isConcerned / mIsShield`。新字段不存在时才以旧 tag 6 bool 补关注值；旧 bool 不足以判断屏蔽，未知枚举和缺失状态不能默认化。

新版 `QGroupConcernedServiceType` 有 1 GET_CONCERNED_LIST、2 ADD_CONCERNED_LIST、3 DELETE_CONCERNED_LIST、4 GET_SHIELDED_LIST、7 ADD_SHIELDED_LIST、8 DELETE_SHIELDED_LIST、9 SET_DEFAULT_LIST。只有 2／7／9 在本研究中闭环了实际 SSO 构造；不能由另外四个枚举拼出命令就称已验证可调用。

`getGroupConcernedSettingPageInfo` 请求包含 groupCode、forceFetch、readCache；响应包含 groupCode、memberListRsp、switchRsp、rspFrom。名单与开关各自有 errCode／errMsg，来源 0=MEM_CACHE、1=DB_CACHE、2=NET_WORK。缓存不是独立云端读回。新版 DTO 的 `msgFriendConcernedList` 不存在于本次旧 protobuf 字段表，不能由 Java DTO 发明 tag 7；native 内核的网络编解码与设置页合并算法尚未闭环。

### 好友特别关心不能混为本群状态

Android 页面用 `isConcerned || isSpecialCare` 显示关注项，再让 mIsShield 覆盖成屏蔽；ViewModel 在 isSpecialCare=true 时仅提示资源 `0x7f12369e` 并返回，不发这三个写命令。`TroopMemberSpecialCareApiImpl` 的值来自 UIN→UID 后的好友 `isSpecialCareOpen()`，不是本群名单。

页面显示关注不证明本群名单包含该成员；Android 的 UI 拦截也不证明服务端拒绝独立设置。实验接入依用户选择将两者保持独立，未自动修改好友特别关心，真实组合行为仍未验证。

## 实测与实验接入结果

以下日期与时间均为 **2026-11-11 北京时间**。不记录真实账号、群号、成员标识或会话物料。

| 阶段 | 执行内容 | 结果与解释 |
| --- | --- | --- |
| 静态研究 | 33 类、10 个字段表及 Android 页面／handler 消费链 | 结构与写调用闭环，不等于当前 Mac 登录态可用 |
| 较早的成员资料扫描，18:21–18:27 | 两群、3 个成员详情目标 | 每次 19 字节，群号及 UIN 回显一致，但仅有 UIN／role=0、无 result，未验证有效详细名片 |
| 本功能新服务只读复核，19:34:03 开始 | 当前匹配进程的已保存 QQ 会话；1 次资料卡赞查询正对照、2 个群的非本人成员读取 | 正对照成功；两次成员提醒读取均缺明确业务 result，未取得完整有效状态。不能当作账号离线，也不能解释为默认设置 |
| 离线定向回归 | 协议 50、服务 8、桌面 131 项 | 189 项通过；覆盖黄金字节、未知／缺失／错目标／拒绝、切号、重复提交及写后确认，数据为夹具 |
| 浏览器夹具 | 两个实际组件入口切换三态、键盘操作、1180／390／320 宽 × 浅深主题 | 6 组通过，检查了菜单溢出、横向滚动和图文对齐；不等于真实 QQ 操作验收 |
| 真实保存与提醒效果 | 未执行 | 业务写入 **0**；保存持久化、Android 同步、整群免打扰／@我的优先级及实际通知效果均未验收 |

实验期间 protocol、service、desktop node 类型检查通过；desktop web 首轮通过，后续共享工作区复查出现其他在途改动中的 4 处类型错误，不称全套类型检查全绿。首次测试命令曾意外扩大为整个 protocol 包：80 文件／1088 通过、1 TODO；后续改为定向运行，不把它当全项目 CI。

首次新服务错误提示为“群成员提醒读取失败（未知）”，随后明确为“服务端未返回群成员提醒状态，请稍后重新读取”；没有将缺结果放宽为成功。实验接入曾采用账号／配置／群／成员隔离、共享在途锁、完整三态写前读取、同值免写和独立读回，不乐观宣称成功、不自动重发写请求。这些实验接口与专用测试现已随功能撤下，历史实现仍在上述提交中。

## 后续恢复条件

先查明当前 macOS 登录态的成员详情最小回包原因，或取得有依据且真实可用的替代读取链路；不能靠更改默认值、猜测枚举／tag 或隐藏错误来恢复入口。签名要求、读取兼容性及业务失败应分别验证和记录。

取得可靠读取后，再按明确目标验证默认→关注→屏蔽→默认、同成员跨群隔离、好友特别关心组合、服务器独立读回、Android 跨端同步及实际通知效果。只恢复代码、收到 ACK 或本地 UI 更新都不能代替这些结果。

## 本次撤下验证

撤下后定向回归 **128 项通过**：协议 44 项（含通用空 ACK、资料展示及扩展协议），桌面 84 项（含路由、群头衔与会话偏好）。新增回归确认 `groupMemberNotifyState / groupMemberNotify` 不再暴露；专用导出、服务接线及两个 UI 入口均已移除。protocol 类型检查、相关文件 Biome 检查和补丁空白检查通过，未跑全量 CI，未新增真实账号请求或修改提醒设置。
