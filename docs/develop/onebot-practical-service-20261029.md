# 实用 OneBot 服务实施记录

2026-10-29（北京时间）。在现有 cc-connect 桥接上实施，不调整版本号，不变更运行中的通道配置。

## 实施清单

- [x] M1：公共参数/CQ 契约、收发、名单、状态与群管理。
- [x] M2：群文件、备注、戳一戳、已读与输入状态。
- [x] M3：账号隔离的消息定位登记、查询、撤回与群消息表情回应。
- [x] M4：群和成员资料、合并转发、历史消息。

## 验证记录

M1/M2：桌面端契约、服务适配和原有桥接 27 项通过，群管理与文件分页 11 项通过；指定本机源码运行的真实 cc-connect Go 适配器合成联测 1 项通过。桌面主进程类型检查通过；本阶段未发送真实 QQ 消息。

群文件扩展以 NapCat 参数结构为主，保留删除文件夹别名；已知输入状态仅支持 event_type=1。语音发送能力为 false。正向 WS 区分根路径、API 专用与事件专用连接。

M3：桌面端 OneBot 定向回归 36 项通过（含真实 Go 适配器合成联测），发送服务 91 项通过；主进程类型检查通过。消息登记按账号与 msgDbPath 隔离，JSON 仅存定位元数据；8192 条上限、登记后 30 天过期、250ms 合并写入，正常停止刷盘。提前持久化分配水位，崩溃不重用 ID。正文从 QQ 本地库与已有漫游缓存读取，撤回复用防撤回缓存保护；不发送真实 QQ 测试请求。

M4 最终回归：桌面 OneBot 55 项、服务相关 135 项、数据库 6 项、协议 6 项共 202 项针对性测试通过。包含真实 cc-connect Go 适配器和仓库现有 NapcatAdapter / SnowLumaAdapter 的独立客户端联测，以及真实 SQLite 夹具的同序号键集分页、uint64 十进制 ID 缓存分页。协议、数据库、service 包及桌面主进程类型检查通过。服务回归范围同时覆盖当前工作区发送服务与防撤回/缓存路径，不把其中其他任务的测试算作本轮新增用例。

## 契约与实现

- `server.ts` 负责回环 WebSocket、媒体 URL、消息登记和分发；`actions.ts` 复用现有名单、群管理、文件与互动服务；`history.ts` 复用已有漫游去重规则；`forward.ts` 负责标准节点转换。
- 群资料使用既有 `0x88d_110` 的 tag 5（容量）、tag 6（人数）。字段依据为 [Lagrange.Core 20c2ba0 的 D88DGroupInfo](https://github.com/LagrangeDev/Lagrange.Core/blob/20c2ba0/Lagrange.Core/Internal/Packets/Service/Oidb_0x88D.cs)，独立硬编码字节夹具验证，未照搬上游实现。
- 资料查询保留未知值：成员头衔过期时间、不良记录、名片可修改性未建模，返回 null；Profile 字段注明本地缓存来源。成员目录强制刷新仍复用并发合并，游标循环、页数耗尽或 PID 改变不发布截断名单。
- 历史默认只读本地和已有漫游缓存；显式在线补全为有界序号窗。原生库按 `(msgSeq, sendTime, msgId)` 键集分页；缓存十进制 ID 以长度与字典序比较，不经 JS number 或 SQLite int64 截断。返回负数消息锚点以支持同序号内部续页。
- 转发支持当前桥接消息段和 ID 引用/嵌套节点；200 节点、8 层、64 MiB 总媒体预算。转发内部缺原会话定位的引用仅作文本展示。所有转换完成后再派发发送，原生发包与最终卡片均复核账号；临时图片文件采用独立名字并在结束后清理。
- 同序号、同发送者、同一秒并不足以认定同一消息：真实 ID 与 random 定位单独登记，引用维护候选集合，歧义时拒绝操作。回归先复现了两条真实记录被弱引用别名合并的问题，再验证各自拥有不同 int32 ID。
- 索引采用原子 JSON 快照与增量日志；250ms 合并写入，仅追加改变的元数据，累计 1024 条或 2 MiB 后压缩。快照带修订水位，崩溃重放不会用旧日志覆盖新快照；残尾恢复保留完整记录。写盘失败时 `get_status.good=false`，新发送在派发前报错，关闭时仍释放监听。

## 快速复验

```sh
WEQ_CC_CONNECT_SOURCE=/absolute/path/to/cc-connect pnpm --dir apps/desktop exec vitest run test/onebot_contracts.test.ts test/onebot_actions.test.ts test/onebot_registry.test.ts test/onebot_server.test.ts test/onebot_runtime.test.ts test/onebot_history_forward.test.ts test/onebot_cc_connect.test.ts
pnpm --dir packages/db exec vitest run test/msg_order.test.ts test/c2c_partition_plan.test.ts
pnpm --dir packages/protocol exec vitest run test/group_join_info.test.ts
pnpm --dir packages/service exec vitest run test/group_moderation.test.ts test/onebot_group_file.test.ts test/onebot_group_members.test.ts test/message_send.test.ts test/roaming_timeline_cache.test.ts test/self_recall_cache.test.ts test/roaming_cache_delete_refetch.test.ts
pnpm --filter @weq/service --filter @weq/db --filter @weq/protocol typecheck
pnpm --dir apps/desktop exec tsc --noEmit -p tsconfig.node.json
```

本轮未修改 cc-connect 源码、运行通道或 NapCat 服务，未签名、安装、发布或进行真实 QQ 写入验收。未调整版本号，未引入依赖；其他任务的工作区改动单独保留。
