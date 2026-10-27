# 克隆提炼流式日志与取消（2026-10-28）

- 克隆创建／更新的提炼调用使用 `stream: true`，复用 `fetchApi` 的用量记账和明确拒绝温度时的兼容回退。服务端仅返回普通 JSON 时仍可读取结果。
- SSE 依据 [Chat Completions streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events) 的 `choices[].delta` 和结束事件读取正文，兼容已有提供方的 `reasoning_content` 扩展；逐字节、CRLF 跨片和尾部用量帧由离线夹具覆盖。缺少结束标记、异常结束或流中业务错误不能当作成功，不自动重发已有输出的请求。
- 通用模型请求默认总期限改为 3600 秒，覆盖读取响应正文；提供方已显式设置的 `timeoutMs` 仍优先。此期限不是空闲超时，持续输出不会重置计时。
- 每个克隆先并发提炼画像卡和样本，再并发提炼表达风格、备用风格和单路深层画像。单个克隆最多三路模型提炼并发；各克隆仍独立构建。
- 关键提炼失败时先取消并等待兄弟请求结束，之后才报告失败和释放重训占用；关闭账号也取消构建并等待收尾。更新失败保留旧画像，错误包含具体阶段和底层原因；可选提炼继续沿用原有降级规则。
- 进度订阅可携带独立 `requestId` 的输出事件。当前任务详情和克隆进度弹窗共用模型日志视图，分段控件选择各请求；推理输出可折叠。原进度不会被流式片段覆盖，失败后仍可回看本次输出。
- 输出以纯文本渲染，不作为 HTML／Markdown 执行。每项任务仅在本次页面会话内保留最近 64 个请求，每路正文／推理各保留末尾 32000 字符；80ms 合批刷新。日志不写入浏览器持久存储，不包含输入语料或认证字段，移除任务／刷新页面会清空。失败的详细错误由后端常规日志保留。
- 本次排障用的临时 localStorage 追踪代码已撤下；已有诊断证据不自动删除。

## 针对性验证

`packages/agentlab/test/extract_stream.test.ts` 覆盖流式／普通 JSON、完成标记、取消、用量和期限；`packages/service/test/agentlab_refresh.test.ts` 覆盖关键失败取消与旧画像保护；`apps/desktop/test/clone_task_output.test.ts`、`clone_tasks.test.ts` 覆盖输出分路、容量、键盘切换、文本转义和缓冲收尾。均为合成数据，不联网、不访问 QQ 数据库。

本轮相关测试合计 96 项通过；AgentLab、Service、桌面主／渲染进程类型检查通过，改动文件 Biome 检查无告警。`test/browser/run-clone-task-log.mjs` 使用本机 Edge 离线验证 5 组浅色／深色／跟随系统、主题色、背景和桌面／390px 视口，检查分段切换、方向键和布局溢出，并人工检查截图。没有调用真实模型复测，也没有运行全量 CI；主进程改动需重启开发版才能加载。
