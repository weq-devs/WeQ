# 只读消息来源元数据

2026-10-26：外部 MCP 只注册审核过的只读工具后，`execute_sql` 不再可用。
学校群整理仍用固定 SQL 补齐年份与发送者，真实接口返回 `Tool execute_sql not found`，
因此普通消息查询成功不能证明来源入队成功。

`get_messages(includeIds=true)` 现在逐条附带 `sendTime`（原始 Unix 秒的十进制字符串）
和 `senderUid`（稳定发送者 UID）。`get_message_details` 同样附带 `sendTime`，
沿用原有 `senderUid`、`kind`、`conv` 和 `msgId`。不依据省略年份的展示时间推算年份。
本改动不开放 SQL、脚本、文件导出或消息写入能力。

消费者应核对返回会话、消息 ID、原始时间与发送者；缺失字段应明确报告契约不可用，
不推进游标或更新整轮成功时间。消息列表可直接入队，无需逐条额外请求详情。

本轮仅源码与合成数据测试验证，未构建、部署或重启正在运行的 WeQ。
运行实例重新加载该实现后，需再次核真实消息字段、全部绑定来源的新检查时间、
自然轮次 `last_source_success_at` 与独立 Patrol。应用存活或端口可达不算恢复。
