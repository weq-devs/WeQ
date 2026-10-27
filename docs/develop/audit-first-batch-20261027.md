# 审计第一批修复（2026-10-27）

范围为 F03（Bot 权威存储）、F01（对端隔离）、F09（发布通知依赖），不包含队列、模型超时、截图、依赖升级或 MainView 重构。

## Bot 权威存储

`packages/bot/src/json_file.ts` 不反向依赖 service，采用等价的同步原子发布契约：
独占创建同目录随机临时文件（0600）、写入、fsync、关闭、rename；目录 fsync 按平台尽力完成。
只有 ENOENT 被视为空库，其他读取失败和结构无效均抛错；不自动修复或覆盖原件。
会话、记忆、笔记、反思水位和关系均先保存再发布内存态，查询返回副本以免绕过持久化。
所有旧 JSON 布局与现有条目上限保持不变。此契约不提供跨进程写锁，不能宣称可安全共享同一 data 目录给多个 Bot 进程。

前台保存失败沿现有生成失败路径报告，不继续发送；后台蒸馏、反思与关系写失败通过 RuntimeLogger 报告。
外部模型请求可能已执行，不因本地保存失败自动重试。完整正文日志问题 F13 尚未在本批修复。

## 私聊与群聊作用域

Bot 从 OneBot 适配器归一化的实际 sender/peer 身份传入 `privatePeerId` 或 `groupId`，不从文本提取身份。
运行时将 `[selfId, personaId, kind, peerId]` 的 JSON 序列化结果作 SHA-256，形成 `bot-scope-v1/<digest>`。
它与合法 persona ID 和旧 `persona:session` 桶不重叠；会话桶、记忆读写/访问计数、反思与水位、关系查询均使用同一作用域。
蒸馏与反思只聚合本作用域的会话；私聊记忆的 aboutId 使用真实对端，不再错标成画像来源。
后台任务捕获本次调用的作用域，不借助可变的“当前对端”。群聊不再回退读取旧 persona 笔记和混合记忆。
编排层短期历史也区分 private/group，避免同号私聊和群聊共享历史。

共享 persona 画像、样本、模型、语音与表情仍按原路径读取。未传新增可选身份的桌面调用保持原行为。
旧混合数据留在旧键中，不猜测归属、不自动迁移、不作为 Bot 新作用域的 fallback。
本批不改变桌面多会话产品语义，也不解决 F05 的同一会话异步竞争。

## 发布通知

两处 QQ Action 固定为 `H3CoF6/qq-notify-action@a0a39df9388de9f0b02b46f96ae6936d0732c8fd`。
2026-10-27 通过 GitHub API 核对该提交的 action.yml 与 src/send.mjs：composite 直接执行 Node 脚本，
仅使用 Node 内置模块，无运行时 npm 安装或其他嵌套 Action；保留消息、附件与大文件纯链接分支。
工作流默认 contents:read，只有桌面/Web 资产发布、macOS 更新清单合并、Release 说明 job 显式 contents:write。
gate 与 qq-notify 继承只读；QQ 凭据仍只作为通知步骤输入。此修复不代表全部 Actions 已固定，也不解决 F10 的最后公开门禁。

## 验证入口

- `packages/service/test/bot_store_safety.test.ts`：坏文件、结构校验、写入/fsync/rename 故障、内存不提交、重启与特殊键。
- `packages/service/test/bot_private_scope.test.ts`：实际运行时与模型 HTTP 请求拦截，双用户蒸馏、反思、重启、跨账号、私聊/群聊与桌面兼容。
- `apps/desktop/test/release_permissions.test.ts`：解析实际 YAML，检查通知分支完整 SHA 与各 job 最小权限。

测试只使用合成数据与本地临时目录，不读取真实 QQ 数据、不连接模型、不触发发布或发送 QQ 通知。
真实 GitHub 发布权限与通知投递仍需正式 CI 环境验收，不将静态工作流测试冒称实际投递成功。

## 本地验证回执

2026-10-27（北京时间）完成：

- 新增的坏文件/写失败、跨对端记忆、通知权限测试均先在修复前复现失败，再修复通过。
- Service 针对性 4 文件、18 项通过（存储 10 项、作用域 5 项、桌面默认模型 1 项、Bot 用量 2 项）。
- AgentLab 包 8 文件、101 项通过；桌面发布工作流 1 文件、2 项通过，共 121 项。
- `@weq/bot`、`@weq/agentlab`、`@weq/service` 类型检查通过。
- 本批 7 个 TypeScript 文件的 Biome check（含 error-on-warnings）通过。
- `pnpm build:bot` 与产物动态 import 冒烟通过，未启动机器人或连接真实服务。
- 未跑全仓 CI、真实 QQ/OneBot 收发、跨平台断电测试、真实 GitHub 发布或 QQ 通知；未部署或覆盖已有导出机器人。
