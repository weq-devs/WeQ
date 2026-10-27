# 审计第二批修复（2026-10-27）

范围为 F04（追加原子性）、F05（Bot 会话顺序与有界队列）、F06（非流式模型请求期限与取消）。
不包含截图策略、缓存容量、正文日志默认关闭、依赖升级与发布公开门禁。

## F04：追加消息

原生契约见 [nt_helper 接口](./nt-helper-interface.md)：写操作只返回受影响行数；`QqDb.write` 在 finally 释放连接。
因此不跨多次 native 调用拼接 BEGIN/COMMIT，也不依赖只读连接执行 INSERT RETURNING。

`appendClonedRow` 采用单条 `INSERT … SELECT`：在写语句快照中读取最新模板与会话内 `MAX(seq)+1`，
同时保护 int64 上限，避免 SQLite 溢出后转成 REAL。透明列仍按调用者覆盖，不透明列继续复制最新模板。
同路径数据库的应用内追加操作再串行协调，队列最多 256 项，完成或失败后回收；入队时冻结消息正文。

原生接口没有行返回值，写后以 msgId、msgRandom 和会话分区核对实际 seq。核对失败明确报告“已执行但结果未确认”，
不会重放 INSERT；模板在写前消失或序号到顶时拒绝追加。msgId 仍沿用原有模板 ID 加随机增量方案，
不宣称它能阻止外部程序自行写入任意重复 msgId，也不改变真实 QQ 源库结构或约束。

SQLite 官方依据：[事务与单写者语义](https://sqlite.org/lang_transaction.html)。离线夹具通过真实生产 SQL 路径测试，
包括独立连接在模板预读后修改序号；未对真实加密 QQ 库执行写测试。

## F05：Bot 队列与停止

以 `chatType:peerId` 为队列键，一次完整处理包含生成、交付与短期历史提交；同会话 FIFO，不同会话默认有界并行。
默认并发 4、总等待 256、单会话等待 32；可由 `BotConfig.queue` 覆盖为正整数。超限直接告警未受理，
不静默丢弃已受理消息；停止时明确报告取消的等待数量。执行失败释放槽位，不自动重试生成或未知发送。
分条延迟仅发生在两条回复之间，不在最后一条之后额外占用队列。

`BotOrchestrator.stop()` 取消执行信号、清空等待并等待在途处理结束；迟到结果不再交付。
`startBot` 的 stop 现在返回 Promise，调用方需要确定收尾完成时应 await；旧调用方式仍能立即触发取消。
重载先等待旧实例停止、后台派生任务结束和统计防抖写盘完成，再构造新实例。
全局停止也覆盖配置读取或启动中的重载，防止停止后重新连接；初始化失败会清理已经建立的资源。
适配器 close 立即结束挂起 RPC；已经发给 OneBot 的操作不能撤销，也不能据关闭连接断言未发送。
新导出入口在 SIGINT/SIGTERM 后等待 stop 完成再退出；启动尚未完成时及强制终止不承诺完成持久化。

## F06：请求期限与取消

`requestApiJson` 为一次逻辑非流式请求创建可清理的总期限，默认 `DEFAULT_API_TIMEOUT_MS`（180 秒）。
通过 `AbortSignal.any` 合并端点、调用者与期限信号，覆盖 fetch、错误正文、JSON 正文及明确温度拒绝的兼容回退。
兼容回退沿用同一信号/期限，不重新计时；未知网络结果、超时或取消不增加重试。
超时归 failed，主动取消归 cancelled；预取消不会发请求或创建虚假账目；成功/失败后均清理期限计时器。
流式 `fetchApi` 继续由现有调用方持有期限及正文生命周期，本批不改变流式接口契约。

可选 `AgentLabProviderConfig.timeoutMs` 经校验、持久化、端点解析和机器人导出透传；旧 UI 编辑缺省该字段时保留已存值。
范围为 1–2147483647 毫秒。没有新增设置控件；默认模型选择、画像与训练样本不变。
Bot 停止信号传入生成、向量、蒸馏、反思和关系任务；后台任务结束前不会开始重载。
桌面账号切换/退出接入 `AgentLabService.close`，取消运行时对话与其后台任务，不宣称它覆盖全部独立画像构建任务。
语音路径补充实例取消（包括正文读取和已有重试等待）；各 TTS 厂商原有请求超时与重试策略未在本批整体重构。

Node 官方依据：[AbortController / AbortSignal](https://nodejs.org/api/globals.html#class-abortcontroller)。

## 回归入口与边界

- DB `append_message`：多句柄并发、唯一约束、私聊 UID 分区、独立连接写入竞争、int64 上限、已提交后回读失败和队列恢复。
- AgentLab `request_deadline`：仅本机假 HTTP 服务，不发头、正文不结束、持续慢流、主动取消、默认期限与计时器回收、TTS 取消。
- `temperature_fallback`：保留原始取消语义与同一合并信号，不要求新增期限后仍与原始信号对象身份相同。
- Service `bot_queue`：顺序与跨会话并行、失败恢复、限额、停止、迟到结果、分条等待取消和单条回复无空等。
- `bot_stop_integration`：实际 OneBot 适配器与本机 WS/HTTP 夹具；WebUI 边界替换为回调夹具，验证运行时停止与重载竞态。
- Provider、统计与第一批隔离/存储回归继续保留。
- `bot_export_shutdown`：实际生成导出产物并运行子进程，用夹具引擎发出进程信号事件，验证入口等待异步 stop，并核对期限随配置导出；不冒称真实终端或 Windows 控制台信号已验收。

所有网络测试仅连接本机测试服务；未连接 QQ、真实 OneBot 或模型端点，未对真实 QQ 数据库或会话执行写入，也未签名、发布或部署。

## 本地验证回执

2026-10-27（北京时间）完成：

- 先复现追加竞争、Bot 同会话乱序、挂起请求无期限，再修复通过；单条回复空等、导出入口不等待 stop 和 Buffer 共享视图也先补失败反例。
- DB 3 文件、15 项通过；AgentLab 5 文件、71 项通过；Service 8 文件、38 项通过，共 124 项。
- `@weq/agentlab`、`@weq/bot`、`@weq/db`、`@weq/service` 类型检查及桌面主进程类型检查通过。
- 本批 27 个 TypeScript 文件的 Biome check（含 error-on-warnings）通过；`git diff --check` 通过。
- `pnpm build:bot` 与产物动态 import / 停止接口冒烟通过，未启动真实服务；未更新已有导出机器人的 runtime 或入口文件。
- 未跑全仓 CI、真实 QQ 库写入、真实 OneBot/模型调用、跨平台终端信号、签名安装与正式发布。
