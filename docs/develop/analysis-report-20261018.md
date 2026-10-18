# 分析与报告

使用方式见[聊天分析与年度报告](../guide/analytics.md)。本文只记录统计和生命周期中容易误用的约束。

## 统计范围

- 好友、群、成员、群会话力图和入群批次接受可选 `startTime/endTime`（Unix 秒，闭区间）。均省略为全部历史；零边界有效，反向或非安全整数窗口拒绝。
- 消息分页使用时间/rowid 稳定游标，不能按 seq 推断时间顺序。空/重复 seq 不丢行；异常时间保留原始游标和计数，但不生成虚假日期。
- 日、小时、火花及年度边界固定使用北京时间；年度日均覆盖起止自然日。年份候选从真实发送时间推导，不要求 QQ 日字段完整。
- 目录合并名册、缓存及消息身份，包含非好友、历史群、退群和名册外发言人。仅 QQ 号成员不伪造 UID，冲突映射不猜身份。
- 入群批次使用当前缓存成员的已知入群时间，不是历史成员快照。成员发言与全群分母使用同一消息时间窗口。

## 账号与结果

- 路由在分派前校验确认时的 uin/configId；已开始的读取持有原服务。此校验不是在途查询取消，客户端仍须拒绝过期结果。
- 工具确认时复制对象与范围，生成独立结果；后续配置不修改既有报告。查询失败可重试，各统计来源独立失败。
- `reportInstance` 隔离同年份报告的客户端缓存、页码和字体，不改变服务端年份口径。隐藏报告停止翻页、预加载和图谱模拟。
- 窄或短内容区使用原字号的滚动阅读布局，宽内容区保留演示画布；阅读滚动不触发翻页。
- 图片保存依赖真实宿主桥接；无桥接的平台禁用，不伪造成功。临时标签不是持久报告，分析长任务与重启恢复仍未统一。

## 源码与回归

| 范围 | 入口 |
| --- | --- |
| 统计 | `packages/service/src/account/buddy_analytics.ts`、`group_info.ts`、`annual_report/`、`common/analytics_time.ts` |
| 分页 | `packages/db/src/msg/browse.ts` |
| 配置与结果 | `views/analysis/`、`views/annual-report/`、`WorkspacePages.tsx` |
| 回归 | `analytics_range.test.ts`、`analysis_directory.test.ts`、`report_time.test.ts`、`report_timezone.test.ts`、`analysis_tool.test.ts`、`analysis_annual.test.ts`、`report_font.test.ts` |
