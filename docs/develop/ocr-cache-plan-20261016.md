# 图片文字识别（OCR）结果缓存 —— 设计规划（2026-10-16）

> 状态：**已落地**（灯箱 / 导出 / MCP 三处都接上了；每个关键行为都有单测：
> `packages/service/test/ocr_cache.test.ts`、`ocr_export.test.ts`、
> `apps/desktop/test/ocr_mcp_tool.test.ts`）。这份文档留作设计记录与取舍依据 ——
> 改动这里的行为前先看「需要你拍板」那几条。
>
> 一句话：把识别结果按 **图片内容 md5** 落一份到 `<缓存根>/ocr/`，
> 灯箱与导出共用同一套读写（`packages/service/src/common/ocr_cache.ts`），
> 命中就把整条腿都省掉（在线请求、本地推理、连筛图都不用跑）。

## 一、为什么需要它：现在是三个入口各跑一遍

| 入口 | 触发 | 链路 | 结果去哪 |
| --- | --- | --- | --- |
| 灯箱 `account.ocrChatImage`（`main/ipc/routers/account.ts:3574`） | 用户点「识别文字」 | 在线 OIDB 0xe07_0 优先，失败 / 不可用回退本地 PP-OCR（`main/ocr/local.ts`） | 只活在渲染层 state（`ImageLightbox.tsx`），关掉灯箱就没了 |
| 导出（`export/ocr_export.ts`，在写） | 勾选「自动 OCR」 | 筛图 → 在线优先（连败放弃）→ 本地兜底 | `<bundle>/ocr.json`，再由 `ocr_rewrite` 回写消息文件 |
| MCP `ocr_image_text`（`main/mcp/tools.ts:2637`） | 外部客户端 / 内置助手调用 | 同一套策略 | 只回给调用者 |

三处互相看不见对方的成果，于是：

- 导出跑过的图，用户回头点开灯箱看，**又跑一遍**（本地那条腿是秒级的）；
- 灯箱识别过的图，导出时**再跑一遍**；
- 同一个 bundle 重导一次、或者断点续跑重来一段，**全量重跑**。

量级参照 [`ocr-models.md`](./ocr-models.md) 第四节的实测（40 行截图、8 线程 2.4–3.4 秒/张）：
一次群导出几百上千张图就是**小时级**，而命中缓存是毫秒级。

缓存还能捞回一件**本来会彻底丢掉**的东西：CDN 直链只有约 9 天有效期（`OCR_DOWNLOAD_ERROR`，
见 `packages/service/src/account/ocr_image.ts`），本机又没落过盘的图，过期后在线那条腿必然失败、
本地那条腿没有字节也跑不了 —— 只有「当时识别过并留下来」的结果还能看。

## 二、用什么当键：内容 md5

| 候选 | 稳定吗 | 三个入口都拿得到吗 | 结论 |
| --- | --- | --- | --- |
| **元素 md5**（45424 大写 hex / 45406 二进制 MD5，归一成小写 hex） | 内容寻址：同一张图转发、跨会话、跨账号、跨导出都是同一个键 | pic 元素**必有**（见 [`pic.md`](../database/nt_msg/elements/pic.md) 第三节）；但渲染视图现在把它丢了（`msg_view.ts:678` `mapPic` 里被注释掉），要打开；`path` 那种入口没有 → 用字节 md5 兜 | ✅ **主键** |
| `fileName` / stem | 多数情况就是 `md5 + 扩展名`（QQ 自己落盘就是 `Pic/<yyyy-MM>/Ori/<md5>.<ext>`，`file_search.ts` 也是按 stem 找的），但这是经验、不是契约 | 导出 / MCP 有，灯箱上下文里没有 | 退路（md5 缺失时）+ 记录里留一份便于人查 |
| `fileToken`（45503） | 每次上传的下载凭据，与内容无必然对应，重传 / 过期会变 | 灯箱有，`path` 没有 | ❌ |
| `msgId + imageIndex` | 同一张图发两次 = 两条缓存，灯箱也没法从灯箱上下文反推 | 都有（MCP 就是这么定图的） | ❌（太窄） |
| 本机文件字节 md5 | 同一张图的「原图 / 预览 / 缩略」是**三个不同的 md5** | 要读盘才有 | 只当第二身份（`path` 入口 / 元素 md5 缺失时） |

还有一件必须跟着结果一起存的事：**「识别的是哪一份像素」**。

- 本地那条腿读的是灯箱正在显示的那张，走 `media_protocol.handleMediaRequest`：
  本机 `Ori` → `Thumb` → chatpic → CDN 下载，可能是缩略图；
- 在线那条腿拿的是元素里记的宽高（服务端再去取图）；
- `blocks` 的坐标是**喂进去那张图**的像素坐标。

所以记录里必须带 `frame { width, height, variant }`；命中时若和当前要显示的图尺寸不一致，
用 `scaleOcrPoints` / `scaleOcrRect`（`@weq/protocol` 已有）换算过去。
`ImageLightbox.tsx` 里 `ocrSize` 那段注释（「不能直接用 ocrContext 的宽高」）就是被这件事咬过的痕迹。

## 三、存到哪里：`<缓存根>/ocr/`

```
<cacheBase>/ocr/<md5 前两位>/<md5>.json
```

`cacheBase = UserConfigService.cacheBaseDir()`（默认 `<appDataRoot>/cache`，用户可在
「设置 → 账号信息 → 缓存路径」改），目录由 app 侧注入 —— 照 `ModelStore`、
`MediaDownloadService`、`RoamMsgCacheDb` 的做法，`@weq/service` 这一侧保持**零原生**（只用
`node:fs` / `node:path` / `node:crypto`）。

**但不要把它加进** `user_config.ts` 的清理白名单 —— 生命周期那一条见下文。

### 为什么放这儿

1. **一个键空间，两个入口都能用**：灯箱在主进程、导出在 `@weq/service`，两边都拿得到这份目录
   （`app_context.ts` 建实例并注入导出依赖，灯箱那条走 `requireServices()`），不需要新 IPC 通道。
2. **跟 `cache/` 的既有约定一致**：目录自动跟随用户的缓存路径覆盖，清理入口已经在设置页
   （`GlobalSettingsSection.tsx:131`），不用新增一套存储概念。
3. **不写回 QQ 库**（对照语音那条线）：语音的转写结果能写回 `nt_msg.db` 的 45923
   （`msg.ts:479 setPttTranscript`），因为那是 QQ **自己的**字段、它自己也认（写进去 QQ 也读）；
   而 pic 上没有已知的 OCR 字段 —— `codec` 里 `picFlag45600` 那层嵌套结构至今是「保留为原始字节」
   （见 [`pic.md`](../database/nt_msg/elements/pic.md) 第四节），即便里面真有，也得先摸清语义才敢写。
   往别人的库里塞未知 tag 风险高，还换不来「QQ 自己也能显示」这个收益。
4. **不放到 `<appDataRoot>/models/` 那种不会被清的地方**：识别结果**多数**可再生成（图还在盘上，
   重跑一次而已），只留「清理缓存」一个出口，符合仓库既有原则（「cache = 可再生成」）。

### 生命周期：借缓存根的位置，但**不进**清理白名单（已定）

`<cacheBase>/ocr/` **不加进** `CLEARABLE_CACHE_CATEGORIES` —— 与 `roam-msg` /
`weq-assistant` / `export` 同一档：都住在缓存根下，但「清理缓存」够不着它们
（`user_config.ts:1369` 起那段注释明确写了「不放 agentlab / weq-assistant / export」）。

理由：**过期图的识别结果一旦被清掉就再也拿不回来**（CDN 链接约 9 天就失效，本机没本体时
本地那条腿也没字节可跑），而体量又小（一张图几 KB），不值得为它冒丢数据的风险。
真要回收就手动删目录；设置页那几行「清理缓存」保持原样，不动。

### 备选后端（现在不做，留迁移点）

`<cacheBase>/ocr/ocr.db`，走 native helper 的 `executeSqlWrite`（照
`packages/service/src/account/roam_msg_cache.ts` 的路子）。等真需要「在所有识别过的图片里
全文搜索」或「十万条级的 LRU / 统计」再换；换的时候只改 `ocr_cache.ts` 的实现，
记录里带 `schemaVersion` 供迁移。

## 四、数据结构与 API

一条记录 = 一个 md5 一个文件（顺便天然去重、天然可 `cat` 出来 debug）：

```jsonc
{
  "schemaVersion": 1,
  "md5": "3fa2c1…c9",                    // 主键（小写 hex）
  "ids": {                                // 便于人查 / 兜底寻址，不参与主键
    "elementMd5": "3FA2C1…C9",            // 元素 45424 原样（大写）
    "bytesMd5": "…",                      // 实际喂给模型的字节 md5（可能 ≠ elementMd5）
    "fileName": "3fa2c1….jpg"
  },
  "frame": { "width": 1280, "height": 720, "variant": "original" },  // original | thumb | downloaded
  "firstSeenAt": 1767000000,
  "lastUsedAt": 1767000000,
  "variants": {
    "oidb":                     { "text": "…", "blocks": [ /* … */ ], "lang": "zh", "at": 1767…, "hits": 1 },
    "local:ppocr-v5-mobile":    { "text": "…", "blocks": [ /* … */ ], "pipeline": 3, "at": 1767…, "hits": 4 },
    "filter:ppocr-v6-det-tiny": { "hasText": true, "boxes": 12, "at": 1767… }
  }
}
```

要点：

- **`variants` 的 key = 生产者身份**（`oidb` / `local:<modelId>` / `filter:<modelId>`），
  在线与本地两份**并存不覆盖**：离线时本地先跑过，之后在线可用还能拿在线那份（精度高一档）；
  换模型 / 改超参（`pipeline` 版本）不会命中旧记录，而不是悄悄吃旧结果。
- **空结果也算结果**（`text: ""`、`hasText: false`），避免反复跑；**失败不进缓存**，
  唯一例外是「在线取不到图」这种确定性失败可以记一条 `online: { fail: 'download_error', at }`
  当提示，下次导出直接跳过（否则又要白试一轮）。
- 读：`get(md5, { prefer: 'oidb' | 'local' | 'any', frame })`；`frame` 不一致就把 `blocks`
  换系后再给调用方。
- 写：临时文件 + `rename` 原子替换；同一 md5 的 in-flight 请求用 `Map<md5, Promise>` 合流
  （灯箱连点两次、导出与灯箱同时跑同一张图），顺带当会话内缓存。
- `blocks` 过大（超长截图）可截断并标 `blocksOmitted`，文字照留；坏 JSON 当未命中并删掉。

API 示意（`common/ocr_cache.ts` 就这么大）：

```ts
class OcrResultCache {
  constructor(root: string);                     // app 侧传 userConfig.cacheDir('ocr')
  get(md5: string, opts?: { prefer?: string; frame?: { width: number; height: number } }): Promise<CachedOcrHit | null>;
  put(md5: string, producer: string, entry: CachedOcrEntry, meta?: CachedOcrMeta): Promise<void>;
  has(md5: string): Promise<boolean>;            // 灯箱门禁用（见第五节）
  size(): Promise<{ files: number; bytes: number }>;
  prune(opts: { maxAgeMs?: number; maxBytes?: number }): Promise<{ removed: number }>;
}
```

## 五、三个入口怎么接

### Step 0（前置，改动极小）：把 pic 的 md5 接出来

没有它就没有共享的键，别的都白搭：

- `msg_view.ts:678 mapPic`：打开 `md5`（`el.md5` 归一成小写；没有就 `toHex(el.md5Bytes)` 兜底），
  `RenderPicElement.data` 加这个字段；
- `export/media_scan.ts:386` 的 `md5: ''` 换成渲染视图里的值（现在那里写着「render 视图没带 md5」）；
- `QqMedia.tsx:198` 那套「合法 32 hex → 小写」的校验已经写好了，接上就有值；
- MCP 定图那步读的也是渲染元素，同样白拿；给 `path` 时算 `md5(字节)`。

### 灯箱（主进程）

```
ocrChatImage(input)
  ├─ md5 有 → cache.get(md5) 命中 → 直接回 { blocks, width, height, source, cached: true }
  ├─ 未命中 → 原逻辑（在线优先 / 本地兜底，见 account.ts:3589-3620）
  └─ 拿到结果 → cache.put(md5, 'oidb' | `local:${modelId}`, …)
```

- 返回值加 `cached?: true`，`OcrTextPanel` 副标题写「在线（缓存）」之类，一行改动；
- **可选但很值**：再加一个只读 query（如 `ocrCacheHas({ md5 })`），让「QQ 离线 + 没下模型 +
  服务端副本已过期」但**以前识别过**的图，`canOcr` 依然可点 —— 这正是缓存最实在的收益场景；
- `put` 时的 `frame`：本地腿用回包自带的 `imageWidth/Height`（可能是缩略图），在线腿用元素宽高。

### 导出（`@weq/service`）

- `ocr_export.ts` 的 `ocrFoundImages` 开头先过一遍缓存：命中的直接写进 `results[fileName]`，
  **不进筛图队列、不进在线队列、不进本地队列**；
- 未命中的照旧走流水线，出结果后 `put`；筛图那条也 `put`（`filter:<modelId>`）；
- 注入点：`task_manager.ts:2194-2217` 那一带加 `ocrCache`，与 `app_context.ts:1349-1350`
  / `1977-1978` 注入 `ocrLocal` / `ocrFilter` 是同一种写法；
- 统计口径：命中**不要**算进 `OcrExportSummary.online` / `local`（建议加 `cached` 字段），
  否则日志里「在线 300 张」会让人以为又发了一轮请求；
- 全命中时 `ocrfilter` 阶段可以直接标完成（`ocr` 阶段仍要跑：写 `ocr.json` + 回写）。

### MCP

`ocr_image_text` 走同一份缓存（工具描述补一句「命中本机缓存直接返回」、返回值加 `cached: true`）；
`path` 那条腿用字节 md5 当键。

## 六、与现有流水线的关系

- 筛图、在线连败放弃（`OCR_ONLINE_FAILURE_LIMIT`）、失败列表（`MediaFailure`）、
  `ocr.json`、`ocr_rewrite` 的语义都不动，缓存只是把「候选」变短。
- **bundle 里的 `ocr.json` 不是缓存**：它是某次导出的产物（回写锚点、可复现、用户可能手改）。
  两层职责分开：全局缓存 = 长期记忆，`ocr.json` = 本次产物，别互相污染。
- 断点续跑（`resume` / `touchStage`）不用动：命中的图照样跑一遍 `ocr` 阶段，只是每张成本
  变成一次读盘。

## 七、落地情况（按当时的顺序）

1. ✅ Step 0：md5 接通 —— `msg_view.ts` 的 `mapPic` 输出 `md5`（大写 hex 归一成小写）、
   `media_scan.ts` 的 `ocr.md5` 填上。
2. ✅ `common/ocr_cache.ts` + 单测（读写 / 原子替换 / 同键并发 / 坏档容错 / 大 blocks 截断）。
3. ✅ 目录建在缓存根下，**不动**清理白名单（见第三节）。
4. ✅ 导出侧：候选先过一遍缓存，命中的一步都不跑（`OcrExportSummary.cached` 单独计一档）；
   在线 / 本地 / 筛图的结果都写回缓存。
5. ✅ 灯箱侧：命中直接返回并标 `cached`（面板副标题写「（缓存）」、不再报「本地模型用时」）；
   新增只读 query `account.ocrCacheLookup({ md5 })` 当按钮门禁的第三条腿。
6. ✅ MCP 侧：`ocr_image_text` 命中直接返回（带 `cached` / `cachedAt`），
   `engine` 明确要某条腿时不拿另一条腿的缓存顶替。
7. ✅ 文档：本节 + `docs/develop/ocr-models.md` 第六节 + 导出 / 语音指南 + CHANGELOG。

---

[← 返回开发者入口](./index.md)
