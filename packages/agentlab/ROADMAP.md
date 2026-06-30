# AgentLab（好友克隆）路线图与设计锚点

> 这份文档是「好友克隆 / 数字分身」功能的设计真相源（source of truth）。
> 每次接着做之前先读它，避免重新捋一遍。会持续更新。
> 最后更新：2026-06-29（调用层 C1~C5 + 记忆/表达风格库已落地）

---

## 0. 一句话愿景

把某个 QQ 好友**蒸馏**成一个稳定人设（借鉴 CipherTalk），再用一套**像真人**的调用引擎驱动它（借鉴 MaiBot）。
一个好友可以被**多次克隆**——换模型、换提示词就是一个新的克隆体。
克隆体自带**人物画像 + 记忆系统**，未来可以：建自己的群聊、导出成 bot client 接入 QQ 适配器真实聊天。

```
CipherTalk = 蒸馏层(build-time)：聊天记录 → 画像/few-shot/问答对/表情/语音偏好
MaiBot     = 调用层(runtime)  ：何时说/说几条/读空气/表达学习/记忆演化/反GPT味
```

参考点详见对话记录与 `packages/agentlab/`（CipherTalk 仓库在 `Documents/GitHub/CipherTalk`，MaiBot 在 `Documents/GitHub/MaiBot`）。

---

## 1. 克隆体（Agent）完整数据模型（目标）

一个训练出来的克隆 AI = 一条 `AgentLabPersona` 记录，存为 `<cacheDir>/agentlab/<exportConfigId>/<personaId>.json`：

```
AgentLabPersona {
  id                  // personaId（同一好友可多条）
  ownerId             // 当前登录账号 uin
  name                // 用户起的名字（可自定义，默认取好友昵称）
  source: {           // QQ 相关 profile（克隆对象）
    kind: 'c2c'|'group'
    targetId          // uid
    uin, nick, remark
    avatarPath?       // 可选缓存头像
  }
  models: {           // 每个任务选哪个 provider+model（model 在 agent 里选，不在 provider 存）
    chat:        { providerId, model }
    embedding?:  { providerId, model }
    vision?:     { providerId, model }   // 解读表情包内容
    voiceClone?: { providerId, model }   // 未来：应用层做，这里只存绑定
    image?:      { providerId, model }   // 未来：发图
  }
  customPrompt?       // 用户自定义提示，拼进 system prompt
  profile: AgentLabPersonaProfile   // 提取出来的内容（画像卡 + 深层 + 风格 + 语音偏好 + 表情偏好）
  fewShots: ...
  stats: ...
  stickers: AgentLabStickerRef[]     // 高频自定义表情包(pic elementType=2 subType=1，本地缓存+解读+场景)；不含 mface
  systemFaces?: string[]             // TA 实际用过的系统表情 faceText 白名单(如 /捂脸 /旺柴)；prompt 只许从这里选，防 LLM 造 /吃饭(见 2.3b)
  voiceProfile?: { ratio, scenarioSummary }  // 语音使用场景（LLM 总结）
  memory: AgentLabMemory             // 对话记忆——我们和克隆体的对话，不是 QQ 记录（参考 MaiBot）
  createdAt, updatedAt               // 最近更新时间
}
```

要点：
- **provider 与 model 解耦**：设置里只存 provider（厂商+base_url+api_key+可用模型列表）；每个 agent 自己选用哪个 provider 的哪个 model 做哪件事。
- **同一好友可多次克隆**：personaId 不同即可，换 models/customPrompt 就是新克隆体。
- **memory 是"我们和克隆体的对话"**，不是 QQ 聊天记录。QQ 记录只在蒸馏期用。memory 供未来导出 bot client 后持续积累（所以现在就预留结构）。

### Provider 数据模型（设置里存的，抄 MaiBot）

```
ProviderConfig {
  id, name            // name 用户可改的显示名
  vendor              // 模板 id：'siliconflow'|'openai'|'deepseek'|'zhipu'|'moonshot'|'ollama'|'openai-compatible'
  baseUrl, apiKey
  models: ProviderModel[]   // { id, label?, capabilities: ('chat'|'embedding'|'vision')[] }
  createdAt, updatedAt
}
```
- 厂商模板（catalog）给：label、默认 baseUrl、推荐模型（带 capability）。**重点推荐硅基流动 SiliconFlow**（`https://api.siliconflow.cn/v1`）。
- 设置页只管 provider 的增删改 + 测试连通；model 列表可从模板带入，也可手填。

---

## 2. 蒸馏层（提取）设计——本轮要补的 CipherTalk 高价值部分

### 2.1 语料获取策略（重要改动：不再"取最近 N 条"）

旧方案：`listLatest(limit)` 取最近 N 条 —— 已废弃。
新方案（一问一答/对话窗口价值优先）：
1. **拉完整对话**：从最新往回 `listBefore` 翻页直到耗尽（设一个安全上限，如 20000 条防极端）。
2. **找高价值语料**：轮次合并 → 抽真实问答对/对话窗口。"价值"= 合并后对方消息数 + 有效问答对数。
3. **阈值兜底**：
   - 私聊高价值语料 < 阈值（如对方有效消息 < 50）→ 去**群聊补采**（该好友所在群里 TA 的发言，只学风格不做问答对，同 CipherTalk）。
   - 私聊 + 群聊仍 < 阈值 → **提示失败**（语料太少，不足以克隆）。

### 2.2 语音（保留本地 wav 路径 + 转录）

- 仅当**设置里配了转录模型且已下载**（`voiceTranscribe.getModelStatus(id).downloaded`）才转录；否则整体跳过、不阻断克隆。
- 流程：pttElement → `FileSearchService.findFile(ts,name,'ptt')` 取本地 silk（缺失则 `MediaDownloadService.download(fileToken,{ext:'.silk'})`）→ `decodeSilkToWav16kBuffer` 转录 → 文本进语料；同时 `decodeSilkToWav` 保留一份 wav 到缓存，路径记下来方便克隆使用。
- 语音使用**场景**：统计 voiceRatio + 调 chat 模型总结"TA 什么场景爱发语音"（可精细化）。

### 2.3 自定义表情包（真正的"表情"= pic 元素 elementType=2 + subType=1，**不是 mface**）

- ⚠️ **元素辨认（容易搞错）**：
  - ✅ **要做**：自定义表情包 = pic 元素（NTQQ wire `elementType=2`）且 `subType===1`。在 codec 里就是 `kind:'pic' && subType===1`。
  - ❌ **不做**：**mface = QQ 商城表情**（不同的 element，codec 里是 marketface 类）——直接跳过、不解析。别把它当表情包。
  - faceElement（系统表情）走 2.3b，不在这条。
- 统计高频表情包 → 本地缓存（照抄导出的寻址+CDN补全：`scanConvMedia` / `downloadMissingImages` / `MediaDownloadService.download(fileToken)`，缓存目录 `userConfig.cacheDir('media')` 或 agentlab 专属）。
- **图像模型解读**表情内容（vision model，从 agent.models.vision 取）+ chat 模型总结**使用场景**（"TA 在什么语境发这张"）。存成 `AgentLabStickerRef { md5, localPath, cdnToken, count, description, scenario }`。

### 2.3b 系统表情 faceElement（`/捂脸` 这类）—— 必须约束成"从固定表里选"，不能学成"斜杠+动作"

- faceElement = QQ **系统表情**，渲染成 `/捂脸`、`/笑哭` 这种（codec: `kind:'face'`，有 `faceId` + `faceText`）。蒸馏期当文本即可（取 `faceText`）。
- ⚠️ **关键坑（务必给大模型讲清楚）**：QQ 系统表情是一个**有限固定集合**，每个 `/xxx` 对应一个 `faceId`。
  - 如果让 LLM 把风格总结成"爱用斜杠+动作（如 `/捂脸`）"，它聊天时就会自由发挥输出 `/吃饭`、`/睡觉` 这种**根本不存在的系统表情**，渲染端无法映射成表情图，变成哑文本 `/吃饭`。
  - 正确做法：**给 LLM 一份常用系统表情清单**（faceText 白名单，如 `/微笑 /笑哭 /捂脸 /流泪 /旺柴 /doge …`），明确说"系统表情只能从下面这个列表里挑用，绝不要自己造 `/动作`"。
  - 提取风格卡时同理：别让 card 写成"爱用 `/动作`"，要落到"常用这几个系统表情：`/捂脸 /旺柴 …`"——从真实语料里**统计 TA 实际用过的 faceText 子集**，只把这个子集喂进画像/prompt。
  - 未来渲染：`faceText → faceId` 直接静态映射回系统表情图（系统表情表是固定的，可建一张静态映射表）。

### 2.4 画像提取（已做：轮次合并 + LLM card/deep/fewshot）

已完成，见 `persona.ts` / `extract.ts`。本轮在其基础上接入 2.1 的全量语料 + 2.2/2.3 的语音/表情产物。

### 2.5 明确不做（本阶段）

- ❌ 自动进化（refreshIfStale / reflect 导演笔记）——意义不大，不做。
- ❌ "最近在聊"记忆注入（蒸馏期的 episodic）——不做。
- ⏸ 语音克隆——很有趣，但放**应用层**做，不在提取层；这里只在 models 里预留 voiceClone 绑定。

---

## 3. 调用层设计（MaiBot 参考，后续阶段）

优先级（性价比）：
1. **分段连发 + 打字延迟**（前端 + `\n---\n` 约定，最快去人机感）
2. **表达风格库**（蒸馏期多抽 `(情景,句式)`，复用向量检索；MaiBot `expression_learner`）
3. **prompt 反 GPT 味约束 + 可选错别字后处理**（MaiBot `typo_generator`）
4. **记忆加 BM25 兜底 + access_count 衰减**
5. **回复意愿评分**（存在感惩罚/空窗补偿；等克隆体自动挂会话再上）
6. 关系三元组 / 情景聚合 / 知识图谱（远期，别早做）

视角转换（务必记住）：MaiBot 是「AI 记住你」，WeQ 是「AI 变成 TA」——表达学 TA 自己的、记忆存 TA 的、回复意愿按"TA 会不会回"。

---

## 4. 未来

- 新建群聊：克隆体自己的群聊（多 agent 互动）。
- 导出 bot client：接入 QQ 适配器真实聊天 → 所以**现在就预留人物画像 + 记忆系统**。

---

## 5. 实施进度

- [x] 轮次合并 + LLM 画像（card/deep/fewshot）+ 问答对向量检索（`persona.ts`/`extract.ts`/`http.ts`）
- [x] 沉浸式 system prompt（反"念设定卡"，借 CipherTalk `personaChatEngine`）
- [x] **Thing 2**：provider 机制重构完成。
      - `ProviderConfig` 改为 `{ vendor, baseUrl, apiKey, models: [{id,label,capabilities[]}] }`，**不再存 chatModel/embeddingModel**。
      - model 解耦：每个 agent 存 `models: { chat, embedding?, vision?, voiceClone? }`（ref = providerId+model）+ `customPrompt` + `name`。
      - 厂商模板 `catalog.ts`：硅基流动(推荐)/deepseek/智谱/moonshot/dashscope/openai/ollama/openai-compatible，模型带 capability。
      - http/extract 改吃 `AgentLabEndpoint{baseUrl,apiKey,model}`；`runPersonaChat(chat, embedding|null, req)`。
      - 解析：`AgentLabConfigService.resolveEndpoint(ref)`，注入 `AgentLabService`（app_context 传 resolver）。
      - 设置页 `AgentLabSection` 重写：厂商模板下拉 + 模型列表编辑器（capability 勾选 + 导入模板推荐）。
      - `AgentLabView` 构建流程改为按任务选模型 + 名称 + 自定义提示；chat 不再传 providerId。
      - ⚠️ 破坏性变更：旧 provider/persona（含 chatModel/embeddingModel/无 vendor/无 models）加载后会被过滤/失效，需重新添加 provider、重建 persona。早期阶段可接受。
- [x] **Thing 1**：全量语料 + 群聊补采 + 阈值兜底；语音转录(本地wav)+场景总结；表情包缓存+vision解读+场景总结；系统表情白名单。（见 `agentlab.ts` 各私有步骤）
- [x] 调用层：分段连发+打字延迟 ✓ → 表达风格库 ✓ → 反GPT味+错别字 ✓ → 记忆BM25/衰减 ✓ → 回复意愿评分 ✓
      - 分段：`http.ts` 单行 `---` 约定分条 + 前端逐条揭示/typing 动画。
      - 表达风格库：`extract.ts:extractExpressions` 蒸馏 (情境,句式) → `http.ts:selectExpressions` runtime 注入。
      - 反GPT味：`http.ts:buildSystemPrompt` 约束 + `typo.ts:humanizeText` 错别字后处理。
      - 记忆：`agentlab_memory.ts` 存（access 衰减遗忘）+ `http.ts:rankMemories`（BM25兜底）+ `extract.ts:distillMemories`（每6回合蒸馏）。
      - 回复意愿：`willing.ts:scoreReplyWillingness`（内容分+存在感惩罚 → 调 temperature/分条/延迟）。
- [x] 蒸馏/调用细腻度增强（对标 CipherTalk 三项，2026-06-30）：
      - **深层画像 map-reduce**：`deep` 不再一次性喂最近语料，改全量历史切块（`persona.ts:renderProfileChunks`，块 10000 字 × 最多 12 块，近况优先）→ 并发 3 `extract.ts:extractProfileChunk` → `mergeProfileParts` 合并；新增 `sharedEvents`（共同经历）维度。service `agentlab.ts:extractDeepProfileMapReduce` 编排，内部不抛（deep 失败不拖垮 card/fewShots）。
      - **对话反思**（自动，每 8 用户回合）：`extract.ts:reflectConversation` 提炼 corrections（用户对扮演的纠正，必须遵守）+ episode（对话摘要）；存 `service/account/agentlab_notes.ts:NotesStore`（notes.json，corrections cap 20 / episodes cap 8 / reflectedCount 水位）；`agentlab.ts:maybeReflect` fire-and-forget；`http.ts:buildSystemPrompt` 注入【扮演纠正】+【你们最近聊过】。与 memory 并存（粒度不同）。
      - **表情包使用情境 contexts**：`AgentLabStickerRef.contexts`（TA 发这张前最近对话短句 ≤3）；`collectStickersAndFaces` 维护 lastText 收集；作为 `describeSticker` 的专属 hint（替代全局语料切片），并进 `sticker.ts` 运行时选表情评分。
- [x] **语音克隆 + 表情自知化 + TTS 多厂商**（2026-06-30，借鉴 MaiBot「动作模型 + 模型自知」，**保持单次调用、不上多轮工具循环**）：
      - **有序自知动作**：`runPersonaChat` 输出解析成 `AgentLabChatAction[]`（text/sticker/voice，`http.ts:parseActions`）；service `chat()` 按序落库 + 返回 `renderedTurns` 供前端逐条揭示。
      - **表情自知化**：prompt 列**编号的真实表情清单**（只列有 description 的），模型 `[[发表情:序号]]` 按内容自己选；`resolveStickerToken` 用同一份过滤清单做编号映射；情绪词/md5 兜底。替代旧「吐情绪词→盲匹配」。
      - **真·语音克隆**：用 TA 真实语音做参考音频复刻。蒸馏期 `transcribePtt` 收 wav+文本+`voiceChanged`+`waveform`，`mapC2cMessages` 只收好友语音、**排除变声**、`scoreVoiceClip`(waveform 有声占比 + 时长 3~10s + 文本)挑 Top-5 → `voiceProfile.refClips`。运行时 `[[语音]]` 前缀 → service `synthesizeVoice` → `agentvoice/<hash>.<ext>` → `[[voice:id]]` turn → `weq-media://agentvoice` → `ChatBubble:VoiceBubble`。门控：TA 发过语音 + 配了 TTS（`PersonaSettingsModal:VoiceTab`，存 `persona.voice` 绑定）。
      - **TTS 多厂商**：`packages/service/src/common/tts.ts`（照 MaiBot tts_voice_plugin 全套 7 家，返回解码五类）；复刻型 cosyvoice(Gradio 免费)+gpt-sovits(本地)；配置 `AppSettings.voiceTranscribe.ttsProviders` + bootstrap tRPC + 设置页「语音配置」。
      - 待真机：登录 QQ 实测发表情准不准 / 语音克隆音色像不像；CosyVoice 公共空间慢会阻塞回复。
- [ ] 远期未做：表达风格库向量检索化 + AI 复审；关系三元组/知识图谱；导出 bot client AI tool（前端灯箱「导出好友」等它）。
- [ ] 未来：群聊（多 agent 互动） / bot client 导出

### 关键文件锚点
- 提取/画像：`packages/agentlab/src/{persona,extract,http,types,catalog,provider}.ts`
- 服务编排：`packages/service/src/account/agentlab.ts`，配置 `packages/service/src/bootstrap/agentlab_config.ts`
- 设置存储：`packages/service/src/bootstrap/user_config.ts`（AppSettings.agentLab）
- 路由：`apps/desktop/src/main/ipc/routers/{bootstrap,account}.ts`
- 前端：`apps/desktop/src/renderer/src/components/settings/AgentLabSection.tsx`、`views/AgentLabView.tsx`
- 复用：媒体寻址 `packages/service/src/account/export/{media_scan,media_export}.ts` + `media_download.ts`；语音 `apps/desktop/src/main/{voice,transcribe/engine}.ts` + `packages/service/src/common/voice_transcribe.ts`；codec `packages/codec/src/element/spec.ts`
