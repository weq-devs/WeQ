# Bot persona 读穿缓存（2026-10-29）

## 背景与范围

导出的克隆体 bot 每条消息都要读 persona：`AgentRuntime.chat`（私聊）、
`handleGroupMessage`（群聊）各调一次 `store.getPersona`，记忆蒸馏再调一次。
父类 `AgentLabStore.getPersona` 是全量 `readFileSync + JSON.parse`；persona 记录内嵌
训练语料 pairs，导出产物还是 pretty-print（2 空格缩进）落盘——语料几千对时单次读取
就是几 MB 的同步磁盘读 + 解析，全部发生在消息处理路径上。

bot 进程内 persona 的写入方只有两处：boot 的语音参考路径回填、WebUI 表情增删，
都经 `savePersona`；运行期基本只读。本轮在 `packages/bot` 新增
`CachedAgentLabStore`（`persona_cache.ts`）并接入 `boot()`，不改 agentlab、
不改桌面端、不改文件格式。

## 改动

- **失效键 = (mtimeMs, size)**：stat 一致直接返回缓存记录；不一致或 stat 失败回落父类
  全量读取（保留 O_NOFOLLOW 符号链接拒绝等安全路径）。
- **读取前后双 stat**：不一致（撞上外部写入）则本次结果不入缓存，避免缓存到半新半旧组合。
- **入缓存的记录深冻结**：bot 全链路（runtime 三处、webui 两处、boot）对 getPersona
  结果只读（已逐一核对，agentlab 内无任何 persona 字段赋值）；冻结把「未来代码原地改写
  共享缓存」从静默污染变成显式 TypeError。回落路径的新鲜对象保持父类语义（可变），
  调用方对两者都应只读。
- **`listPersonas` 不缓存**：仍返回新鲜可变对象——boot 的 refClips 路径回填依赖可写。
- **`savePersona` / `deletePersona` 后失效**对应条目；父类写失败抛错时缓存不动，与磁盘一致。

与存储热路径优化（消除整库深拷贝的 PR）相互独立、无文件交集；若两者都合入，
`persona_cache.ts` 的本地 `freezeDeep` 可改为复用 `json_file.ts` 的 `deepFreeze`。

## 实测（Windows 11 / Node v22.23.2，合成夹具，pretty-print 落盘，同一会话新旧对比）

| persona 大小 | 父类每次读取 | 缓存命中 | 冷读（一次性） |
| --- | ---: | ---: | ---: |
| 1.1MB（2000 对语料） | 5.37ms | 0.027ms | 7.5ms |
| 4.4MB（8000 对语料） | 20.62ms | 0.023ms | 24.7ms |

命中路径只剩一次 `statSync`；收益随语料增大而增大。每条私聊消息节省一次全量读取，
群聊与蒸馏轮次节省更多。代价：常驻内存多一份解析后的 persona（MB 量级，与文件同阶），
以及命中时返回共享冻结对象（见上）。

## 边界

- 外部改写后 mtimeMs 与 size **都恰好不变**的极端情况不被感知（返回旧记录）；
  进程内写入全部经 savePersona 失效，不受此限。
- 命中路径的 statSync 跟随符号链接但不读内容；真实读取永远走父类安全路径，
  换成符号链接要么 miss 后被父类拒绝，要么命中返回旧缓存，不会读到链接目标新内容。
- 非法 id 跳过缓存，由父类 `assertPersonaId` 统一报错；id pattern 不含路径分隔符，
  拼接不可能越界。

## 验证

- 新增 `packages/service/test/bot_persona_cache.test.ts` 8 项（bot 契约测试按既有惯例
  放在 service/test）：命中同一冻结对象与改写抛错、尺寸变化 / 同尺寸 mtime 变化失效、
  savePersona / deletePersona / 外部删除失效、非法与不存在 id、listPersonas 可变、
  跨 id 不串数据。时间用 utimesSync 显式拨动，不依赖文件系统时间粒度，跨平台稳定。
- 既有 `bot_*` 契约测试全绿（8 文件 48 项），其中 `bot_stop_integration` 走真实
  `startBot` 链路，端到端覆盖缓存接入后的启动 / 收发消息 / 停止 / 重载。
- `pnpm --filter @weq/bot typecheck`、`pnpm --filter @weq/service typecheck`、
  Biome check、`pnpm run build:bot`（442.8kb）通过。
- 未验证：真实 QQ 数据长跑、NapCat/SnowLuma 实机、Linux/macOS 量化复测。
  基准为本机合成场景，不代表真实倍数。

## 本轮不做

- agentlab 侧（桌面端共用）的 persona 缓存：桌面写入方多（画像更新、配置编辑、表情管理），
  失效面与一致性要求不同，需要单独评估，不在 bot 专用子类里顺带做。
- WebUI / 桌面导出链路的行为不变，未动。
