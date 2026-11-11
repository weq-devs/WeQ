# 群内单成员消息提醒

## 接口与分层

`GroupMemberNotifyMode` 为 `default | concerned | shielded`。protocol 的 `getGroupMemberNotify / setGroupMemberNotify` 只处理网络协议，service 的独立 `GroupMemberNotifyService` 负责从当前群成员记录解析数值 UIN、写前读取、同值免写及进程切换核对。GroupInfoService 的 `getMemberNotify / setMemberNotify` 为业务入口。

`account.qqWrite.groupMemberNotifyState` 接收账号／配置绑定、groupId、uid，返回 groupId、uid、memberUin、mode、rawMode、complete；`groupMemberNotify` 额外接收 mode，返回现有写操作结果 accepted／unchanged／unconfirmed。读写均经在线账号解析，前后验证来源。个人设置不要求管理员或好友身份，不把已离群的本地记录直接当作服务端拒绝。

## 读取

SSO 为 `group_member_card.get_group_member_card_info`。请求 protobuf：1 groupCode:uint64、2 uin:uint64、3 newClient=true、4 clientType=1、5 richCardVersion=1。

响应 1 为群号、3 为成员结构。成员内 1 为 UIN、2 为 result、3 为错误文本、30 为 concern_type。必须匹配群号与 UIN 且 result 明确为 0。状态 0／1／2 分别对应默认／关注／屏蔽；缺失或其他原始值返回 mode=null、complete=false，不能依据旧 tag 6 bool 推断完整三态。只有最小成员回包、缺业务结果时提示服务端未返回状态，不能用生成类默认值冒充成功。

## 保存

| mode | SSO | OIDB serviceType | GroupConcernedInfo 本次字段 |
| --- | --- | ---: | --- |
| default | OidbSvc.0x8bb_9 | 9 | 6 repeated uint64 UIN |
| concerned | OidbSvc.0x8bb_2 | 2 | 3 repeated UinInfo，子字段 1 UIN |
| shielded | OidbSvc.0x8bb_7 | 7 | 5 repeated ForbidUin，子字段 1 UIN |

command=0x8bb；根节点 **1 write_req → 1 repeated GroupConcernedInfo**，群号为 GroupConcernedInfo tag 1。只发单个目标与当前选择，不带 update_time、from 或关键词字段。不能改用 OidbSvcTrpcTcp，也不能用删关注列表代替恢复默认。

复用 legacy OIDB envelope 与中央签名策略。保存使用 `allowEmptyBody=true`，允许外层 result=0 的无业务体 ACK；helper 默认仍要求业务体，非零 result、缺失 result、错命令及截断仍拒绝。未知签名需求不登记成已确认不签名。

保存前取得完整三态；相同选择返回 unchanged。明确 OIDB 拒绝抛出错误，其他无法确认提交结果的异常返回 unconfirmed，不自动重发。accepted 不是已确认持久化，前端由现有 `useQQWriteSession` 仅重试独立读取，匹配目标状态才提示完成。

## 两个入口与验证

成员名片与头像菜单共用 hook、查询键及在途锁；关闭的头像菜单不挂载查询。缓存键包含账号、配置、群、UID，切换目标不沿用旧状态。仅管理云端设置，不修改 QQ 数据库、会话名称或 WeQ 的消息筛选／本地通知规则。好友特别关心不合并、不联动，也不作为此设置的修改前置。

协议黄金字节、缺失／未知／错误响应、服务串行与切号、路由身份绑定、UI 双入口同步和失败处理见各层 `group_member_notify` 测试；浏览器检查由 `apps/desktop/test/browser/run-group-member-notify.mjs` 提供，使用合成数据且不联网修改账号。真实云端状态、保存持久化及 Android 跨端效果必须另行记录验收，离线夹具通过不能替代。
