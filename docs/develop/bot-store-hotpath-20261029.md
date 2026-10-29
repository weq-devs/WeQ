# Bot 存储热路径：整库深拷贝消除与冻结发布（2026-10-29）

## 背景与范围

导出的克隆体 bot 是长跑 Node 进程，每条消息都要过 `packages/bot` 的 JSON 存储
（`conversations.json` / `memories.json` / `notes.json` / `relations.json`）。原实现在消息
热路径上对整库做多次全量深拷贝：

- `JsonConversationStore.append`：先 `get()`（structuredClone 整桶）再 `replace()`
  （校验整库 + structuredClone 整库 + stringify 整库 + fsync）；
- `JsonMemoryStore.get`：每条消息 structuredClone 整个 scope——记忆带嵌入向量时
  （200 条 × 1024 维）单次克隆即数 MB～十几 MB；
- `JsonMemoryStore.touch`：命中记忆再来一轮「整 scope 克隆 + 整库克隆重写」。

克隆防御的是「调用方保留引用后修改已发布数据」，但 bot 内所有写入方（stores 自身）
都构造新值，读取方（AgentRuntime / Orchestrator）只读。防御性克隆实际是把成本
压在了每条消息上。本轮只改 `packages/bot`（`json_file.ts` / `stores.ts`），不改文件格式、
原子写契约（fsync + 同目录临时文件 + 原子替换，见审计第二批）、失败语义
（写盘失败不发布、损坏原件拒绝加载）与桌面端。

## 改动

- `BotJsonFile.replace(next)` 改为**所有权转移**：校验 → 先 `JSON.stringify`（环状引用
  在此先失败，`current` 与 `next` 均不受影响）→ 原子写盘 → 成功后 `deepFreeze(next)`
  并发布，不再整库 structuredClone。加载路径同样冻结发布。
- `deepFreeze` 为迭代实现且**跳过已冻结子树**：依赖「本类冻结过的树必然整树冻结」
  不变量，增量 replace 只冻结本次新放入的对象；未变更的大头子树零成本，且新旧
  `current` 共享这些子树（不再复制）。
- 读取返回「新数组 + 逐条浅拷贝」：标量字段修改依旧对存储无害（与旧深拷贝语义一致，
  `bot_store_safety` 的「返回值不可绕过持久化」契约不变）；嵌套数组（向量、关键词）
  共享**冻结**引用，原地改写会抛 TypeError 而不是静默污染——比旧的「克隆后随便改」
  更严格，现有代码没有这种写入（agentlab 消费端全部只读，已逐一核对
  `rankMemories` / `runPersonaChat` / distill / reflect / 群聊关系路径）。
- 写入用最小新鲜副本：`touch` 只为命中条目构造新对象（O(命中数) 而非 O(整库)）；
  `append` / `add` / notes / relations 同理。`applyDelta` 返回脱钩副本，保持旧语义。
- `isMemories` 对**冻结条目跳过字段级扫描**（发布不变量：冻结条目必然已通过校验）。
  `isRecord` 前置，防 `Object.isFrozen(原始值) === true` 把 `[42,'x',null]` 之类混过校验
  （有专项测试）。`isTurns` 字段检查本身便宜，不引入跳过。

## 实测（Windows 11 / Node v22.23.2 / pnpm 12.8.1，合成夹具，不碰真实 QQ 数据）

夹具：`conversations.json` 3.2MB（50 桶 × 400 轮）、`memories.json` 12.1MB
（10 scope × 200 条 × 1024 维向量）、persona 1.1MB（2000 对语料）。新旧代码在同一
会话背靠背跑同一基准（vitest 计时 + `node --expose-gc` 内存采样）。

单操作耗时（每条消息一次）：

| 操作 | 旧 | 新 |
| --- | ---: | ---: |
| `memories.get`（整 scope 含向量） | 70.0ms | 0.1ms |
| `conversations.append`（3.2MB 整库重写） | 85.7ms | 37.7ms |
| `memories.touch`（12.1MB 整库重写） | 1481ms | 693ms |
| `relations.applyDelta` | 6.6ms | 2.8ms |
| 热路径 structuredClone 次数 | ≥5 次/条 | 0 |

「一条命中记忆的已回复私聊消息」完整存储循环 × 20 次（get + touch + append）：

| 指标 | 旧 | 新 |
| --- | ---: | ---: |
| 每循环耗时 | 1633ms | 674ms |
| 循环期间峰值堆增长 | 211MB | 3.6MB |
| RSS 增长（20 条后） | +248.5MB | −6.6MB（不增长） |
| 显式 GC 后滞留堆 | +30.5MB | +0.1MB |

代价与边界：冻结使加载后的常驻堆从 20.4MB 升到 51.7MB（15MB 夹具；一次性、随数据量
线性，换来的是每条消息数十 MB 的瞬时分配归零）。剩余耗时是整文件
validate（已收敛到新增条目）+ stringify + write + fsync——单文件 JSON 格式的下限。

## 验证

- 新增 `packages/bot/test/store_hotpath.test.ts` 13 项：冻结发布、增量冻结共享子树、
  读拷贝语义（标量可改无害 / 嵌套冻结抛错）、一轮消息零 structuredClone、
  原始值不得借冻结混过校验、MAX_TURNS/MAX_MEMORIES/笔记截断去重、touch 未命中不重写。
  bot 包自此有 `test` 脚本（vitest ^2.1.8，与其他包一致）。
- 既有契约测试全绿：`@weq/service` 的 7 个 `bot_*` 文件 40 项（含 `bot_store_safety`
  的损坏原件拒绝、write/fsync/rename 失败不发布、`__proto__` 特殊键往返；
  `bot_private_scope` / `bot_stop_integration` 以真实 AgentRuntime + 假 LLM 驱动私聊 /
  群聊 / 停止路径）。
- `@weq/agentlab` 131/132：唯一失败是 `store_security` 的 symlink 用例在本机
  Windows 无符号链接权限（EPERM），平台性误报，与本轮无关（未改 agentlab）。
- `pnpm --filter @weq/bot typecheck`、`pnpm --filter @weq/service typecheck`、
  Biome check 通过；`pnpm run build:bot` 产物 442.2kb 正常。
- 未验证：真实 QQ 数据长跑、NapCat/SnowLuma 实机部署、Linux/macOS 上的量化复测、
  NAS 级低速磁盘表现。基准是本机合成场景，不代表真实倍数。

## 本轮不做（后续方向，涉及产品决策或跨包）

- `AgentLabStore.getPersona` 每条消息全量重读 persona 文件（1.1MB 实测 ~10ms/条，
  语料更大更慢）：bot 侧可加 mtime+size 校验的读穿缓存；桌面端共享该类，需另行评估。
- 整文件 stringify + fsync 是剩余大头：按 scope 分桶落盘、或仿 `stats.ts` 的 200ms
  防抖合并写，都触碰权威数据耐久性语义，需要先对齐再动。
- `BotOrchestrator.histories`（每对端 40 轮）与 `StatsStore.byDay` 均无上限，
  长跑进程缓慢增长，可加 LRU / 保留期。
