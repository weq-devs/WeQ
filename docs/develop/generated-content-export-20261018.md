# 生成内容精确导出

本页说明已持久化的克隆与助手记录如何形成独立导出快照；用户操作见[统一导出](../guide/export.md#克隆与助手对话)。

## 身份与来源

- 复用 `GeneratedSearchSources` 的账号服务，只读已经持久化的 persona、group、assistant 对话，不创建会话、不调用模型。
- 目标由 `kind / ownerId / sessionId` 三元组标识。旧版克隆的 `sessionId=null` 是独立记录，不表示草稿；助手旧记录由现有服务迁入真实会话。
- 内容选择 container 使用三元组 JSON，避免对象、会话中含冒号时发生串范围；外层 `clone-messages / assistant-messages` 与内部 kind 一致才接受。
- 所有生成读取与导出路由要求账号 uin 和 configId，复用现有账号断言，拒绝同号在线/静态数据源互换后的旧请求。

## 精确选择与快照

三类正文复用账号共享多选及已有键盘契约。只有实际持久消息 ID 进入选择组；临时流式回合没有伪造身份。克隆逐段展示结束、助手运行结束后可同步新持久快照，为新回合补上真实 ID。

工具只复制选择，不反向清理正文多选；每个目标保留独立范围，窗口化范围列表支持键盘定位。空集合不能提交，已选条目缺失时明确报错，不自动丢失条目或转为整个会话；读取未完成不冒称条目缺失。

确认时复制目标、ID 与格式参数，准备保存位置期间不受后续草稿变化影响。服务端在创建任务时检查对象/会话和每个已选 ID，深复制正文、原始角色、过程、动作、回复和提及结构。任务执行不再回读源会话，源删除、后续回答或清空不改写任务。

## 产物与任务

- 支持 JSON、JSONL、TXT、CSV、XLSX。JSON 使用 `weq-generated-content/1`，JSONL 使用逐消息 `weq-generated-message/1`；表格和 TXT 保留来源与完整记录 JSON 列。
- `origin=local-generated`、原始毫秒时间、对象与会话身份始终保留。没有 QQ 服务器消息身份，不套用 QQ 或 ChatLab schema，也不调用漫游补全。
- 产物先写入独立 staging bundle，再原子发布；写入或取消失败不暴露半成品。任务一次只保存一份快照，多格式共用同一份数据。
- 复用统一保存策略、自动保存回执及 Web 下载链路。暂停/崩溃后按快照重新执行，不冒称字节级断点；同一任务保留原 ID 和目标。
- 任务列表只返回快照身份、范围和计数，不在每次轮询中重传完整正文与工具过程；完整快照仍存于服务端任务记录。

资源标记及助手产物引用保持原记录内容，同时按已有账号句柄将本地语音、表情和已完成的助手附件随包保存。多格式共用 `resources/`，`generated-resources.json` 记录消息映射、相对路径、实际复制时间、逐文件校验和缺失状态；任务列表只返回资源数量，不重复传输快照。任务详情、收拢摘要及失败明细均明确区分资源缺失与完整成功，正文仍可保存。

暂停或重启后先校验已保存资源，不调用模型或回读已变化的原件掩盖快照问题；旧任务恢复时补齐资源阶段。成功后只清理已经持久化并发布的重复私有副本；清理失败不把已发布结果改为失败，删除任务时清理该任务的缓存和独立报告，不删除已另存的结果。

完整性契约限定为 `known-generated-assets`，HTML/Markdown 附件内部的外链和脚本保持原文，不自动抓取或承诺完全离线。剩余离线化工作见[能力盘点](content-capability-census-20261018.md)。

## 回归入口

- service `generated_export.test.ts`：三种来源、旧版记录、精确 ID、空集合、缺失拒绝、结构深复制、真实五格式、自动保存、列表轻量投影、暂停及新管理器恢复。
- service `generated_resources.test.ts`：已知资源随包保存、同名隔离、缺失明细、重启校验、原件删除、快照变更、旧任务恢复和缓存清理。
- desktop `generated_task_result.test.ts`：部分资源缺失的完成状态、失败明细及暂停收尾状态。
- desktop `generated_export_router.test.ts`：账号与同号数据源拒绝、空集合及缺失 ID。
- desktop `generated_export_ui.test.ts`：结构化身份、草稿隔离、确认冻结、切号停止及不可用范围禁用。
- desktop `generated_search_ui.test.ts`：三类正文共享多选及新持久快照身份更新，保留原搜索定位回归。

服务实现位于 `account/generated_content.ts`、`account/export/generated_export.ts` 和 `generated_resources.ts`；测试均使用合成数据，不替代真实来源的资源可用性检查。
