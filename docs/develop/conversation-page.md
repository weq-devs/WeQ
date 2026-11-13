# 统一会话页与助手运行

## 页面契约

普通私聊、临时会话、群聊、数据线、克隆私聊、克隆群聊、频道私聊、WeQ 助手、公众号及服务号均由同一个 `ChatPane` 绘制完整会话页。来源适配器负责查询、身份投影、发送和运行控制，不提供另一套标题栏、消息循环或编辑器。

共用部分包含标题栏、虚拟时间线、消息行与气泡外层、右键菜单、多选栏、输入区、滚动条、分页触发和定位。Markdown、工具过程、QQ 富消息及生成文件通过正文渲染器扩展。名片内预览、搜索结果、缺口消息和转发查看器仍保持各自的局部查看用途。

源码入口：[ChatPane](https://github.com/weq-devs/WeQ/blob/dev/apps/desktop/src/renderer/src/im-template/template/chatPane.tsx)、[只读来源适配器](https://github.com/weq-devs/WeQ/blob/dev/apps/desktop/src/renderer/src/components/ReadonlyConversationPane.tsx)、[助手适配器](https://github.com/weq-devs/WeQ/blob/dev/apps/desktop/src/renderer/src/views/agentlab/AssistantPanel.tsx)。

### 来源能力

- 频道私聊、公众号和服务号不提供发送能力，平时收起输入区，多选时显示共用操作栏。
- 克隆和助手复用共用编辑器；图片选择、附件和上传状态进入输入区的扩展区域。
- 来源不支持的共用操作置灰并说明原因；不能把本地生成身份、appId、nodeId 或设备伪 UID 当作普通好友处理。
- 标题资料使用现有来源字段。没有可编辑项时不提供空设置页，也不伪造好友关系或在线状态。
- 分页通过 `onLoadOlder`、`onLoadNewer` 回调触发，宿主通过 `onTimelineElement` 接收当前消息列表元素，不查找其他页面的消息 DOM。
- 已缓存的气泡沿用 `withMessageBubbles → seedMessageBubbles → MessageBubble` 链路，预热不等待解码、不延迟正文发布。

## 只读来源

`readonlyConversationPage` 接受公众号 `peerUid` 或服务号 `appId`，支持最新页、历史游标、新消息方向和消息锚点，默认每页 50 条。游标复用数据库的序号、发送时间与消息 ID 组合，保留重号、零/NULL 序号和负消息 ID。

目录、完整消息页、媒体扫描和正式导出不再仅保留 Ark；文本、图片、混合元素、无 prompt 的 Ark 及未知元素都不应因此消失。`listOfficialAccountArkFeed`、`listServiceAccountArkFeed` 仍保留旧接口语义，完整会话不调用它们。

`searchReadonlyConversation` 在实际来源中分页检索，不能用前端已加载窗口代替完整记录。精确导出冻结来源和消息 ID；服务号使用 appId 分区，频道使用 nodeId，不能退化为普通私聊导出。

## 助手设置

设置为应用级共享值，不提供账号、设备或会话覆盖。输入区只保留模型、思考等级快捷选择；**运行中发送行为只在助手设置中配置默认值，输入区不提供逐条模式选择。**

| 分类 | 参数 | 初始默认 |
| --- | --- | --- |
| 模型与生成 | 模型、思考等级、温度、单次输出 Token 上限 | 跟随默认模型、跟随模型、0.3、模型默认上限 |
| 任务执行 | 最大推进轮数、单工具超时、任务总时限 | 24 轮、60 秒、600 秒 |
| 上下文管理 | 带入历史条数、上下文预算、压缩触发/目标比例、摘要上限 | 12 条、32768 Token、70%/50%、1500 Token |
| 提示与工具 | 运行模式、额外提示词、外部 MCP | 沿用已有配置 |
| 图片处理 | OCR/视觉模型偏好 | 沿用已有偏好 |
| 运行中发送 | 立即补充、下一步补充、排队发送 | 立即补充 |

任务轮数和时限可以选择“不限制”；输出上限的“跟随模型”表示不设置该上限。单次输出上限也约束标题和摘要请求，摘要同时受专用摘要上限约束。压缩目标必须低于触发比例，摘要长度必须低于上下文预算。

模型配置可声明 `reasoningEfforts`。未声明时提供“跟随模型、低、中、高”；跟随模型表示不传 `reasoning_effort`，不等同于保证模型不思考。所选模型不可用时保留引用并提示，不静默换模型。参数回退必须依据服务端明确指出不支持的参数，不能把其他 400 错误当作思考参数不兼容。

选择项即选即存，文本和数值完成有效编辑后自动保存。失败保留输入并可重试，提供恢复默认入口；不增加手动冲突选择或覆盖确认。

独立任务启动或显式继续时固定有效配置，包括实际解析出的模型端点、生成参数、提示、任务与上下文参数、MCP 和图片策略。当前任务不受后续配置更新影响；同一任务内的补充沿用原快照。发送行为默认值控制消息受理方式，由宿主在新消息提交时读取；重试沿用首次受理的实际模式。

## 三种发送行为

| 默认行为 | 运行中收到消息时 |
| --- | --- |
| 立即补充 | 中断当前模型请求；正在执行的工具先收尾，尚未开始的同批调用跳过，再带补充继续当前任务 |
| 下一步补充 | 不中断当前模型调用及对应工具批次，在下一步模型调用前加入当前任务 |
| 排队发送 | 当前任务正常完成后，按顺序启动下一项独立任务，启动时读取最新参数 |

运行时可以编辑输入和准备图片，发送与停止同时存在。停止意图不依赖 runId 已返回，不能因创建会话或提交尚未响应而失效。

补充后的记录按时间分段：已有回答片段、用户补充、后续回答各有稳定消息 ID，并关联同一任务。不保留没有正文或过程的空片段。流式占位不进入正式导出选区。

过程默认运行时展开、完成后收起；手动调整的状态优先。工具调用与结果配对展示，参数和结果可以展开、复制；计划、笔记、文件仍作为正文内容渲染。失败和停止状态保留在对应回答中，有真实恢复点才提供继续，否则可以重新编辑消息，不自动从头重跑任务。

## 队列与恢复

队列持久化在所属账号与数据源的助手目录，按会话隔离。可以编辑、取消和调整待执行顺序；幂等请求 ID 防止重试重复受理，取消后的回执也不会把消息重新入队。

正常完成后继续下一项；手动停止、外部取消或失败后暂停并保留队列。重开应用或账号后不自行执行。用户可以继续当前任务并恢复队列，或跳过当前任务执行下一条。

提交、队列查询/编辑和控制接口绑定账号及数据源。事件携带 sessionId、runId、messageId、taskId 和来源标识，队列启动后无需前端代发请求。切换界面不停止宿主任务，也不要求保留隐藏聊天 DOM。

工具执行前后保存检查点；恢复使用已确认的结果，不重发已开始且终态未确认的调用。清空内容与永久删除会话保持区别，均等待对应任务写入收尾，再移除相应历史、断点和队列，不影响其他会话。

## 定向回归

```bash
pnpm --filter @weq/service exec vitest run test/assistant_unified_runtime.test.ts test/assistant_api_usage.test.ts test/readonly_conversation.test.ts test/feed_export.test.ts
pnpm --filter @weq/desktop exec vitest run test/unified_conversation_contract.test.ts test/guild_direct_selection.test.ts test/clone_conversation_ui.test.ts test/conversation_switch.test.ts
node apps/desktop/test/browser/run-unified-conversation.mjs
```

浏览器夹具使用合成消息和模拟接口，不连接真实 QQ 数据库。复用现有 Playwright 环境；可通过 `WEQ_PLAYWRIGHT_IMPORT`、`WEQ_BROWSER_EXECUTABLE` 指定已有运行时，通过 `WEQ_STYLE_ARTIFACTS` 保存截图。验证应覆盖所有来源、桌面/窄屏、深浅主题、只读多选、长 Markdown、设置保存及运行中发送默认值，而不只检查静态源码或最终截图。
