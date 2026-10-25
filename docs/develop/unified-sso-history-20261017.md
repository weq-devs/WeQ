# SSO 历史读取与兼容

普通缺口、导出补全和[批量任务](batch-roaming-backfill-20261016.md)共用 `GapHistoryService.fetch`。

## 单窗契约

- 新任务仅接受 `transport=sso`，每次调用至多一个、跨度不超过 30 个 seq 的物理请求，不宣传服务器 500 条大页。
- 所有历史入口共享进程内 FIFO，派发之间至少 500ms，批量任务可设更长间隔；排队后复核缓存、在线与离线设置。
- 派发前执行预约持久化回调，失败不发包。缓存命中与排队不算在线请求，网络时长不混入队列和落盘时间。
- 核验账号、精确会话、NT seq、ID 与窗口，保存原始 protobuf，区分 msgId/newId/random。同 seq 不同 ID 均保留，不按 seq 覆盖。
- 缺身份的群观察进入独立观察表，不混入正常消息、导出或覆盖；错误身份直接拒绝。
- **同 seq 同 ID 只算一次，不判整窗失败。** 服务端确实会回这种记录：私聊通话记录（`msgType=19`）挂靠在宿主消息上，复用宿主的 seq 与 `newId`（本地 `c2c_msg_table` 里同样是两行同 `40003`）。缓存表主键本来就是 `(kind,conv,msg_seq,msg_id)`，两条存不下，所以解码时保留第一条、第二条记成 `duplicate_message_identity` 观察后跳过。**不能改回抛错** —— 那样一条挂靠记录就会把整窗 29 条一起判失败。
- 整窗核验和缓存写入成功后才返回成功；在途取消仍可保存有效结果，但不发下一窗。空/短响应不证明记录已恢复。
- 拉窗失败一律 `warn` 落日志（`scope=gap-history`，`event=gap-window-failed`）。非 strict 路径在有缓存时会降级成 `ok:true + networkError`，不打日志的话前端只会看到「没拉到」，排查无从下手。

## 兼容边界

| 旧记录 | 行为 |
| --- | --- |
| `sso30` / 无 transport | 保留原选项 hash 与计数，可继续统一小窗实现 |
| `sso500` / `native500` | 可查看、取消和移除，不可继续/重试；需新建 SSO 任务 |
| 旧 gap/protocol/native 缓存 | 不搬库、不删除；有效旧记录继续参与查看与导出，不伪造缺失的原始字节 |

`historyVersion=2` 用于前后端契约检查，旧后端禁用新任务并提示更新。研究采集代码不属于产品读取路径。

源码：`account/gap_history.ts`、`sso_history_window.ts`、`roaming_backfill.ts`；测试使用临时 SQLite 和合成响应验证身份、同 seq 多 ID、预约、写盘失败、取消及旧选项 hash。涉及 main/service/RPC 的更新需要加载新后端，仅 renderer HMR 不足。
