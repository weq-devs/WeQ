# Bot 存储分桶落盘（可选布局）：单文件写入下限与全量常驻的结构性解法

日期：2026-10-30 · 范围：`packages/bot`（`bucketed_store.ts` 新增，`stores.ts` / `config.ts` /
`index.ts` 接线）· 状态：已实现并实测，**缺省关闭**（`config.storage.bucketed` 显式开启）

## 背景

#118（存储热路径）消除了整库深拷贝、#119（persona 缓存）消除了每消息全量重读之后，
消息热路径剩余两个**结构性**成本，都无法在单文件布局内解决：

1. **写入下限**：任何一次 `replace` 都是整文件 validate + stringify + fsync。记忆带向量、
   多对端积累后单库可达 10MB+，每次 touch/add/append 的耗时与库总量成正比（O(全库)），
   与本次改动大小无关；
2. **常驻内存**：启动即 parse 全部 scope 并冻结常驻——bot 只在跟一个对端说话时，
   其余对端的会话与记忆也在内存里。

## 方案

`BucketedJsonDir<V>`：conversations / memories 的每个 scope 一个文件
（`<name>.json` → `<name>.d/<hex(key)>.json`，hex 编码兼容含 `/` `:` 的键）。

- **写入只动单键文件**：校验 value → stringify(value) → 原子写（tmp + fsync + rename）→
  深冻结发布进缓存。契约与 `BotJsonFile` 同款：失败不发布、损坏原件拒绝加载且不波及他键；
- **惰性加载 + LRU**（默认 64 桶）：只缓存最近使用的 scope；淘汰只丢内存副本
  （写入永远同步落盘，无丢数据窗口），下次访问从磁盘读回；
- **legacy 迁移**：桶目录不存在且旧单文件存在时一次性拆分（迁移**只落盘不灌缓存**，
  保持惰性收益），旧文件改名 `.migrated` 保留；中途失败可重入（以旧文件为准重拆，
  半迁移的桶文件被覆盖）；
- `JsonConversationStore` / `JsonMemoryStore` 增加 `BotStoreOptions { bucketed?, maxCachedBuckets? }`，
  公开 API 与语义零变化（读仍返回脱钩浅拷贝、写仍所有权移交、400/200 截断不变）；
  笔记 / 关系库体量小（每对端几十～几百字节），不分桶；
- `config.storage.bucketed` 缺省 **false**：不开启则代码路径与行为和现状完全一致。

## 实测（Windows / NVMe，端到端真引擎）

同一种子（1.6MB persona + 0.6MB 对话 + **11.9MB 含向量记忆、10 个 scope**），
24 条命中记忆的私聊消息，假 NapCat + 假 LLM（固定 30ms），三方 LLM 调用数一致（26）：

| 指标 | 官方 2.3.2 | #118+#119（单文件） | 分桶（本方案） |
| --- | ---: | ---: | ---: |
| p50 单条延迟 | 1458ms | 706ms | **79ms** |
| p95 / max | 1612 / 1697ms | 782 / 792ms | **97 / 144ms** |
| 24 条总耗时 | 31.8s | 15.6s | **2.0s** |
| 峰值 RSS | 538MB | 192MB | **153MB** |
| 基线 RSS（加载后） | 140MB | 188MB | **137MB** |

- 单文件版基线高于官方：冻结元数据常驻（#118 的已知代价）；分桶版靠惰性加载低于两者；
- 延迟收益来源：touch/add 从 O(12MB) stringify+fsync 变为 O(1.2MB) 单桶；
- 对端数越多、向量越厚，收益越大；单对端小库场景两者差距收窄（写入本来就小）。

## 验证边界

- 新增 8 项专项测试：往返与截断一致性（桶 vs 单文件行为对齐）、hex 文件名可逆、
  legacy 迁移完整性与 `.migrated` 保留、半迁移重入、损坏桶拒绝且不波及他键、
  LRU 淘汰后从磁盘完整读回、冻结语义与读拷贝契约、缺省布局不产生 `.d` 目录；
- 既有 bot / service 契约测试全绿（缺省 false 下零行为变化；service 的 startBot
  集成链路两种布局各跑一遍）；
- 未实测：ext4 / 机械盘上的迁移与写入耗时（预期迁移一次性成本 ≈ 整库 stringify 一轮，
  运行期收益不变）；超大对端数（>10k 桶）的目录遍历（`keys()` 为 readdir + 解码，
  getAll(prefix) 场景如有需要可再加索引）。

## 已知取舍

- 单 scope 超大时该桶的写入下限仍在（O(单对端) 而非 O(全库)——结构性缩小，不是消除）；
- 目录文件数 = 对端数，对现代文件系统无压力；备份/迁移工具需按目录整体拷贝
  （`.migrated` 原件保留即天然回退点）；
- `keys()` 每次 readdir：getAll(prefix) 频率低（组装上下文时），实测无感；
  如成为热点可缓存键清单并在 set 时增量维护。
