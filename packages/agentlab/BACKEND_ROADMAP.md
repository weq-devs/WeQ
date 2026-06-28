# AgentLab 后端补全 Roadmap（重后端，另开会话做）

> 这些是 AgentLab 的**重后端**任务，需要去两个外部大仓找借鉴点：
> - CipherTalk：`C:\Users\17078\Documents\GitHub\CipherTalk`（蒸馏 / 画像 / 表达风格）
> - MaiBot：`C:\Users\17078\Documents\GitHub\MaiBot`（调用引擎 / 反 GPT 味 / 记忆演化）
> 读这两个仓的大文件会**撑爆上下文**，所以单独开干净会话做，先读本文件 + `ROADMAP.md`（§3 调用层）。
> 来源：用户 2026-06-29 需求陈述。前端侧进度见 `FRONTEND_ROADMAP.md`。

## 前置（前端会话已做的轻后端）
- ✅ WeQ助手：调用已注册 AI tool registry（前端会话接线）。
- ✅ 聊天记录持久化：和克隆体/助手的对话落盘（基础存储；记忆机制在下方 §3 深化）。
- ✅ token 按模型记账（供主页图表）。
> 若前端会话只做了占位，这里要补实现。

> 进度更新：2026-06-29。B1/B2/B3 + C1~C5 已实现（见下方 ✅）；仅剩 §5「其它 AI tool（导出）」未做。

## 必做项

### 1. 反 GPT 味（参考 MaiBot）✅
- ✅ `http.ts` `buildSystemPrompt` 强化反 GPT 味约束（平淡简短、禁 markdown/列表/序号/冒号前缀/旁白、不浮夸、别像客服，借 MaiBot 的 reply_style / 输出指令）。
- ✅ 错别字后处理：新增 `packages/agentlab/src/typo.ts`（`humanizeText`）——手挑同音/形近混淆组 + 偶尔吃句尾句号，确定性 PRNG，默认强度 ~0.18，逐条作用在分段后的消息上。MaiBot 用 pypinyin/jieba，这里降级为离线词表近似。

### 2. 聊天记录持久化存储（深化）✅（已完成）
- 和克隆体/助手对话的结构化存储 `agentlab_conversation.ts`。供 §3 记忆蒸馏与未来导出 bot client 持续积累。

### 3. 克隆体记忆机制 + 人物画像机制（参考 MaiBot）✅
- ✅ 存储：`packages/service/src/account/agentlab_memory.ts`（`MemoryStore`，按 personaId 分桶落 `memories.json`）。每条带 `accessCount`/`lastAccessedAt`，容量超限按「强度=access 热度+时间新鲜度」淘汰 → access_count 衰减式遗忘。
- ✅ 检索：`http.ts` `rankMemories`——关键词重合（BM25 兜底）+ access 强度加成；无命中也带最近/最常想起的几条保持连续感。命中的 id 回报给 service `touch()` +access。
- ✅ 形成：`extract.ts` `distillMemories`——每 6 个用户回合从最近对话蒸馏「克隆体对对方（用户）」的新事实，fire-and-forget 不阻塞回复。
- ✅ 注入：system prompt 的「你记得关于对方的事」块。对应前端灯箱「记忆 / 画像」（已接线 `getAgentLabMemories`/`forgetAgentLabMemory`/`clearAgentLabMemories`）。

### 4. 画像提示词微调 / 表达风格库（参考 CipherTalk / MaiBot）✅
- ✅ 表达风格库：`extract.ts` `extractExpressions` 蒸馏期多抽 `(情境,句式)` 对，存 `persona.expressions`；`http.ts` `selectExpressions` runtime 按情境关键词 + count 选几条注入 prompt（低优先「看情况自然用」）。比口头禅更细，缓解「偏口头禅」问题。
- ⏳ 仍可深化：向量检索选择（现为关键词+count 加权）、AI 复审 expression 质量。

### 5. 补全 WeQ AI tool 其它能力 ❌（未做，唯一剩项）
- 例如**导出**（对应前端灯箱「导出好友」仍是占位）。复用 `packages/service/src/account/export/` 链路。
- 把更多 WeQ 操作注册成 AI tool 供 WeQ助手调用。

### 6. token 按模型记账 ✅（已完成）
- `agentlab_usage.ts`，主页图表已接。

## 调用层（ROADMAP §3，性价比顺序）
1. ✅ 分段连发 + 打字延迟（`http.ts` 用单行 `---` 约定分条，前端逐条揭示 + typing 动画 + `replyDelayMs`）
2. ✅ 表达风格库（同 §4）
3. ✅ 反 GPT 味（同 §1）
4. ✅ 记忆 BM25 / 衰减（同 §3）
5. ✅ 回复意愿评分（`willing.ts` `scoreReplyWillingness`：内容分 + 存在感惩罚 → 0~1，调节 temperature/分条数/`replyDelayMs`；1:1 不抑制回复，只调「上心程度」）
6. ⏳ 关系三元组 / 知识图谱（远期，未做）
