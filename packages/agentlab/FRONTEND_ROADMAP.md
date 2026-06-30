# AgentLab 前端补全 Roadmap（执行中）

> 本会话负责「前端补全 + 轻后端」。重后端（反 GPT 味 / 记忆机制 / 画像提示词微调）见 `BACKEND_ROADMAP.md`，另开干净会话做。
> 来源：用户 2026-06-29 的需求陈述（真相源）。每次接着做先读本文件。

## 0. 范围与策略

- **本会话做**：前端全部 + 轻后端三件（① WeQ助手调用已注册 AI tools ② 聊天记录持久化 ③ token 按模型记账，供图表用）。
- **占位 + 写进 BACKEND_ROADMAP**：反 GPT 味、克隆体记忆/画像机制、画像提示词微调、WeQ AI tool 其它能力（如导出）。
- **复用优先**：聊天渲染复刻 QQ → 复用现有 `apps/desktop/src/renderer/src/im-template/`（chatShell/rail/sidebarHeader）；好友选择列表 → 参考现有好友列表实现（带头像/昵称，走 `useProfileResolver`）。

## 1. 设置页面优化

`apps/desktop/src/renderer/src/components/SettingsDialog.tsx` + `components/settings/*`。
- 按钮太大、风格不统一 → 统一按钮尺寸/样式（`weq-set-btn` 体系）。
- 保存成功无提示 → 加 toast/inline 成功反馈（复用 `useAppDialog` 或加轻量 toast）。
- 通查各分区交互一致性（间距、标题、空态）。

## 2. AgentLab 页面完全重写

入口 `views/AgentLabView.tsx`（推倒重写）。核心概念：AgentLab 里有两类 **agent**——
**WeQ助手** 和 **好友Skills(好友克隆)**。

### 2.1 杂项
- 左上角搜索按钮 → 在 CSS 里隐藏（`styles/index.css`）。

### 2.2 两类 agent

**WeQ助手**（预设 agent）
- 预设好，调用**已注册的 AI tools**（复用工具注册表，见记忆 `mcp-server-feature` 的 transport-agnostic 工具注册表）帮用户完成操作。
- 聊天页**顶部设置按钮** → 弹出灯箱：自定义模型配置、额外提示词、外部 MCP 服务器等。

**好友Skills（好友克隆）**= 现在做的克隆功能。
- **新建**：弹出好友**列表选择**（参考其它好友列表实现，带头像/昵称）。
- 选完 → 配置：选模型 / 是否分析表情 / **克隆程度**（高=遍历全部对话；低=只取最新 N 条）。
  - UI 明确提示：**高克隆度 = 更大 token 消耗**。
  - 接后端：克隆程度映射到 `buildAgentLabFromC2c` 的 `limit`（高→C2C_SAFETY_CAP 全量；低→小 N）+ `models.vision` 有无（是否分析表情）。

### 2.3 克隆进度条
- 构建过程分阶段（拉语料/转录/表情/画像/向量），用 tRPC subscription 或轮询回报进度 → 进度条。

### 2.4 聊天页面复刻 QQ 渲染
- 和好友/助手聊天页 **复用 `im-template`** 渲染（气泡、头像、昵称、分条），不要另起一套。

### 2.5 好友顶部设置灯箱（5 项）
1. 查看训练参数（现有 PersonaParamsPanel 内容搬进灯箱）
2. 自定义额外提示（customPrompt 编辑）
3. 是否开启语音克隆（开关，先占位绑定 `models.voiceClone`）
4. 对自己的记忆 / 画像（占位 → 依赖后端记忆机制）
5. 导出好友（占位 → 依赖 WeQ AI tool 导出能力）

## 3. Token 统计 + 主页图表

- **轻后端**：在 agentlab 的所有 LLM 调用处（`packages/agentlab/src/{http,extract}.ts`）回收 `usage`（OpenAI 兼容返回 `usage.{prompt,completion,total}_tokens`），按 **模型 / 克隆体 / 时间** 记账，持久化（service 层 store）。
- **主页（未选任何 agent）**：展示 消耗 / 各模型消耗 / 各克隆体消耗 / 时间消耗 等统计图表。

## 实施顺序（低风险自洽 → 高耦合）
1. 设置页优化（自洽）
2. AgentLab 重写骨架：分层(助手/好友Skills) + 新建好友选择弹窗 + 模型/克隆度配置 + 进度条
3. 复用 im-template 复刻聊天渲染
4. 好友顶部 5 项设置灯箱（部分占位）
5. token 记账 + 主页图表（含轻后端记账）
6. WeQ助手 tool-calling（接工具注册表）

## 状态（更新 2026-06-29）
- [x] 1 设置页优化（`weq-set-btn` 体系 + Toast 反馈）
- [x] 2 AgentLab 重写骨架（助手/好友克隆分层、好友选择弹窗、模型/克隆度配置、进度条 subscription）
- [x] 3 聊天渲染复刻（复用 im-template 气泡）
- [x] 4 好友设置灯箱：①训练参数 ②额外提示 ③语音克隆开关 均已实现；④记忆/画像 **已接线**（`MemoryTab` + getAgentLabMemories）；⑤导出好友 仍占位（依赖后端 AI tool 导出）
- [x] 5 token 记账 + 图表
- [x] 6 WeQ助手 tool-calling（openai_tools 注册表）
- [x] 补充：分段连发 + 打字延迟（onSend 逐条揭示 + `.weq-agentlab-typing` 动画，吃后端 `segments`/`replyDelayMs`）

- [x] 系统表情渲染：克隆体回复里的 `/捂脸` 这类 faceText 在气泡里渲染成表情图。
      `emoji.db`→`EmojiService.listSystemFaces`→`account.getSystemFaces`→`ChatBubble` 用 persona.systemFaces 白名单 + faceText→faceId 映射（复用 `FaceEmoji`）。
- [x] 分段连发逐条落库：`chat()` 每个 segment 存为独立 assistant turn，重启/切换历史保持分句。
- [x] 历史实时性：发送后 / 切入克隆体时 invalidate `getAgentLabConversation`，修复「切走切回丢历史」。

### 仅剩
- ⑤ 灯箱「导出好友」——等后端 BACKEND_ROADMAP §5 的导出 AI tool。
- 克隆体「发自定义表情包 / 发语音」——见 BACKEND_ROADMAP（需 sticker 引用协议 / TTS 语音克隆，应用层）。
