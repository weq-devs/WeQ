# 本地文字识别（OCR）模型

> 现状：**本地引擎已经接上灯箱和 MCP 了** —— 聊天图片的「OCR」按钮在线优先
> （OIDB 0xe07_0）、在线不可用或失败时回退本地模型（见第四节）；MCP / 内置助手那边
> 是同一个策略，两个工具 `get_ocr_status` / `ocr_image_text`，返回值里标明这次用的
> 是哪条腿。**导出侧的批量自动 OCR 也已经接上**（筛图 → 在线优先 → 本地兜底 →
> 回写消息文件），三个入口的识别结果**共用一份按图片 md5 寻址的本机缓存**
> （见第六节）。
>
> 模型侧这一轮的落地：注册表 [`packages/service/src/common/ocr_models.ts`](../../packages/service/src/common/ocr_models.ts)、
> 通用仓库 [`model_store.ts`](../../packages/service/src/common/model_store.ts)、
> 设置页 `apps/desktop/src/renderer/src/components/settings/OcrModelsSection.tsx`。

## 一、为什么选 PP-OCR

在线那条线（OIDB 0xe07_0，见 [`packages/protocol/src/oidb/ocr-image.ts`](../../packages/protocol/src/oidb/ocr-image.ts)）
的产物是：**逐行文字 + 4 个角点 + 外接矩形**，坐标就是喂进去那张图的像素坐标，另有一个
段落标记。

PP-OCR 的「检测（DBNet）+ 方向分类 + 识别（CRNN/SVTR）」三段式**天然**就是这个形状：
检测网络输出的本来就是多边形框（不是矩形），识别网络给每框文字 + 置信度。所以本地版
不需要重新设计数据结构，能直接产出同构的 blocks —— 灯箱覆盖层、`OcrTextPanel` 那套
按 `rect` 画框的 UI 可以原样复用。

## 二、选的模型

上游是 ModelScope 的 `RapidAI/RapidOCR`（PaddleOCR 官方 PP-OCR 模型的 ONNX 版，与官方
发布同源）：

<https://modelscope.cn/models/RapidAI/RapidOCR/resolve/master/>

`resolve/master` 会 302 跳 CDN，下载器（`model_store.ts`）已经处理重定向与 Range 分片。

| 用途 | 注册表 id | 档位 | 文件 | 体积 |
| --- | --- | --- | --- | --- |
| 识别（出文字） | `ppocr-v5-mobile` | PP-OCRv5 mobile | det + rec + cls + dict | 21.5 MB |
| 筛图（只判断有没有文字） | `ppocr-v6-det-tiny` | PP-OCRv6 det tiny | det | 1.7 MB |

精确字节数、落盘文件名与 URL 都写在注册表里（**唯一事实源**，别在这份文档里抄第二份）：

| 文件角色 | 落盘名 |
| --- | --- |
| `det` | `ch_PP-OCRv5_det_mobile.onnx` / `PP-OCRv6_det_tiny.onnx` |
| `rec` | `ch_PP-OCRv5_rec_mobile.onnx` |
| `cls` | `ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx` |
| `dict` | `ppocrv5_dict.txt` |

### 为什么筛图用「检测模型」而不是一个分类器

需求是「这张图值不值得 OCR」。检测网络的输出为空本身就等于「没有文字」，而且是全家族
里最省的档位（1.7 MB），还不需要字典与识别网络 —— 不需要再单独训一个"截图 / 风景"
分类器。

代价：tiny 档在小字、低分辨率、低对比上更保守，可能把「文字很少」的图判成没有文字。
实测结论在第五节（真实抽样 140 张，与识别模型的检测头一致率 95%，误判两个方向都有）；
接线时按那里给的判据收紧，或者把筛图换成 `ch_PP-OCRv5_det_mobile`（4.6 MB，更稳）。
**加档位是纯注册表改动**，UI 逐条渲染。

## 三、存储与下载

- 落在 `<appDataRoot>/models/<id>/`，和语音模型**同一个根**（id 全局唯一，靠前缀
  区分；`voice_transcribe.ts` 与 `ocr_models.ts` 不许撞 id，有测试兜着）。刻意**不放在
  cache 目录下** —— 「清空缓存」不该把模型一起清掉。
- 下载机制（多线程分片 / 单线程流式、进度事件、状态、删除）在
  [`common/model_store.ts`](../../packages/service/src/common/model_store.ts)，语音与图片
  两个家族共用，`ModelStore<T>` 只管文件级的事，不认识模型语义。
- 设置项：`settings.ocr.modelId`（识别模型）/ `settings.ocr.filterModelId`（筛图模型），
  空 = 未选。数值都指向注册表 id。
- IPC：`bootstrap.ocrModels` / `downloadOcrModel` / `onOcrModelProgress` /
  `deleteOcrModel` / `setOcrModel({ kind, modelId })`。

## 四、推理引擎与接线（已落地）

分工和语音那条线一样：**模型管理在 `@weq/service`（零原生），推理在 app 侧**。

| 文件 | 干什么 |
| --- | --- |
| [`main/ocr/pipeline.ts`](../../apps/desktop/src/main/ocr/pipeline.ts) | 纯 TypeScript 的 PP-OCR 管线：det 前后处理 / 透视裁切 / 方向分类 / CTC 解码 / 段落分组。不 import onnxruntime（会话以最小接口注入），所以能单测 |
| [`main/ocr/worker.ts`](../../apps/desktop/src/main/ocr/worker.ts) | fork 出去的子进程入口：加载 `onnxruntime-node`，跑管线，回一行行结果 |
| [`main/ocr/engine.ts`](../../apps/desktop/src/main/ocr/engine.ts) | 主进程这侧：fork worker、喂裸 RGB、把结果整成与在线版同构的 `OcrBlock` |
| [`main/ocr/image.ts`](../../apps/desktop/src/main/ocr/image.ts) | 字节 → 裸 RGB（Electron 的 `nativeImage`，不额外引解码库） |
| [`main/ocr/local.ts`](../../apps/desktop/src/main/ocr/local.ts) | 可用性判定（模型下好没）+ 取图（复用媒体协议那条链）+ 跑引擎 |

要点：

- **隔离**：`onnxruntime` 是原生库、CPU 推理每张图几百毫秒到几秒，所以跑在 fork 出来的
  子进程里（照 `transcribe/worker.ts`）——崩了只死这一个 worker。
- **线程**：`intraOpNumThreads = min(8, 核数)`。实测 16 核机器上一张 40 行的截图：默认
  线程 6.1s，8 线程 2.4-3.4s，再往上（12 / 16）反而变慢。
- **超参**：det `limit_side 960` / `thresh 0.3` / `box_thresh 0.5` / `unclip 1.5`；
  rec 高度归一 48、宽度按长宽比（≥320），**超过 1600 就切段识别再拼回来**（超长行硬喂
  会掉出训练分布）；cls 只在置信度 ≥ 0.9 时才转 180°。
- **坐标系**：产出与在线版同构 —— `quad` 4 角点（左上 → 右上 → 右下 → 左下）、`rect`
  外接矩形、`parag`（`{"Parag":{"ParagNo":n}}`）、`field2` = 置信度 ×100。灯箱覆盖层
  按**回包自带的** `imageWidth/Height` 换算（本地那条腿可能拿到的是缩略图，用元素里
  记的原图尺寸会错位）。

### 灯箱（图片大图）的接线：在线优先、本地兜底

`account.ocrChatImage` 一个入口两条腿，策略在主进程里：

1. **在线**（OIDB 0xe07_0）：QQ 在线 + 未开完全离线 + a2/d2/d2key/guid 齐全时优先走它
   （见 `ocrOnlineBlocker`）。它拿 `fileToken` 现签 CDN 直链交给服务端。
2. **本地模型**：上面缺一项，或者在线那条路**失败**（图过期 / 服务端取不到）时，用
   `settings.ocr.modelId` 指向的模型跑一遍。取图复用 `media_protocol.handleMediaRequest`
   ——渲染层把灯箱正在显示的 `src` 递进来，等价于主进程自己发一次同一个「虚拟请求」，
   本地落盘 → chatpic 备份 → CDN → OIDB 补下 的优先级白拿。

返回值带 `source`（`oidb` / `local`），灯箱据此在结果面板上标「在线 / 本地模型」。
**按钮门禁**：`getGroupAlbumAccessState` 多返回一个 `ocrLocalModelId`，渲染层按
「在线可用 或 本地模型下好了」决定能不能点；两条腿都没有才置灰并说明原因。

### MCP / 内置助手的入口：`get_ocr_status` + `ocr_image_text`

同一个策略也挂在工具注册表（[`main/mcp/tools.ts`](../../apps/desktop/src/main/mcp/tools.ts)）
上，因此外部 MCP 客户端与内置助手都能调：

| 工具 | 干什么 |
| --- | --- |
| `get_ocr_status` | 查两条腿现在各能不能走（在线：QQ 在线 + 未开完全离线 + 物料齐全；本地：识别模型已下载并选中），`reason` 给出不能走的原因 |
| `ocr_image_text` | 定一张图 → 识别文字，`engine` 可选 `auto`（默认）/ `online` / `local` |

**怎么定图**：`kind` + `conv` + `msgId` 定位聊天里的图片（同一消息多张图用 `imageIndex`），
或者直接给本机文件 `path`（绝对路径 / `~/` 开头）。

**取图那一步按 MCP 的处境改写**：外部调用者没有渲染层的 `weq-media://` 地址，所以走消息
定位时图片字节直接从本机媒体缓存里捞（`fileSearch`，与 `transcribe_voice_message` 同一条
路，取不到就如实报错）；`path` 那种则直接读盘 —— 这也是 `local.ts` 的取图链新长出来的
一条腿（`data:` / 本机路径 / `weq-media://` / `http(s)://` 四条来源）。

**回给调用者的区分信息**（用户要的「能看出走的哪条」就落在这三个字段上）：

- `source`：`online` / `local`；
- `engine`：中文说明，如「在线接口（QQ 图片文字识别 OIDB 0xe07_0）」/「本地离线模型
  （ppocr-v5-mobile，本机推理，未联网）」；
- `offline`：布尔，`true` 即本地离线模型（这次没有任何图片内容离开本机）。

另外 `notes[]` 记录中途的回退与跳过原因（例如「在线接口没成：服务端已经取不到这张图了」
「本机没有已下载的识别模型，本地这条腿走不了」），失败时返回 `ok: false` + `error` +
`notes`，而不是抛一句没头没尾的错。

两个工具都**只读**（不写库、不上传文件），所以照常进外部 MCP 只读面板；`path` 那条腿
只能走本地模型 —— 在线接口要的是聊天图片的 `fileToken`，本机文件没有。

### 导出侧：`ocrfilter` + `ocr` 两个阶段（已落地）

导出里的自动 OCR 与语音转写**同构**：和消息导出并发跑，产物 `ocr.json` 落在 bundle
根目录，消息文件早在落盘时就埋好了锚点，最后由回写把文件名换成文字。差别只有一条 ——
语音锚点是 `[语音: 名字]`，图片是 `[图片: 名字]`（HTML 是图片下方的
`<small class="cap">名字</small>`，只在勾了 OCR 时渲染，免得给所有导出加文件名水印）。

```
预筛选（ocrfilter）┐        识别（ocr）                              回写
筛图模型 det-only ├─▶  在线 0xe07_0（新→旧、并发、连败 10 张放弃）
  没文字的图跳过   │       └─ 没拿到的 → 本地 PP-OCR ──▶  ocr.json ──▶ [图片] 文字
（两条腿**并行**）┘
```

第 1、2 步是并行的：筛图在后台跑，在线 worker 只等**自己那张图**的结论（`verdicts` 里的
promise），筛好一张就发一张 —— 以前是「整批 56 张筛完才开始在线」，白等一次筛图的时间。
承诺必须在开跑前**全部**摆好，否则晚到的 worker 会把「还没筛到」当成「不用筛」直接发请求。

代码分工（和灯箱那条线一样，service 零原生）：

| 位置 | 干什么 |
| --- | --- |
| `@weq/service` `export/ocr_export.ts` | 三步流水线的**策略**：预筛选、新→旧排序、并发、连续失败放弃、本地兜底、失败记账、写 `ocr.json`。纯 TS，可单测 |
| 同上 `runBatchWithFailureLimit` | 通用的「并发 + 连续失败就整体放弃」执行器（单测钉住语义） |
| `@weq/service` `export/ocr_rewrite.ts` | 回写：TXT / CSV / ChatLab JSON 换 `[图片: 名字]`，HTML 换那行小字（多行转 `<br>`） |
| `apps/desktop/main/ocr/local.ts` | 注入的两条本地腿：`runLocalOcrFile`（出文字）/ `runLocalOcrFilterFile`（只判断有没有文字） |
| `apps/desktop/main/ocr/online.ts` | 注入的在线腿：0xe07_0 一张一发 + **rkey 缓存**（批量只签一条，约 45 分钟） |
| `export/task_manager.ts` | 两个阶段 + 进度 / 日志 / 回写时序（和语音转写一样等消息文件落盘） |

**几个刻意的选择**：

- **预筛选只对本机有本体的图生效**（要读像素）。本机没有、又还没过期的图直接送在线 ——
  服务端自己去 CDN 取图，不需要本地有文件。
- **筛图失败的图按「有文字」处理**：宁可多跑一次识别，也不静默丢文字。筛图模型中途
  不可用（被删了）则整体跳过预筛选，只留一条告警。
- **判据是「检测框非空」，但丢掉面积占整图 ≥ 90% 的框**（`main/ocr/filter.ts` 的
  `judgeTextBoxes`，纯函数可单测）。140 张实测样本上这条规则只改判 2 张（都是 420×420、
  框正好等于整图的误报）；剩下的误报（占比 59-64%）与「整屏都是文字的小截图」在面积、
  置信度上都分不开 —— 加置信度阈值（≥ 0.5）一个都没滤掉（误报框的分数有 0.91-0.96），
  所以判据**故意留松**：多跑几张识别只是慢一点，漏判是真丢文字。
- **在线从新到旧试，连败 10 张就放弃**（`OCR_ONLINE_FAILURE_LIMIT`）：服务端取不到图
  往往是整批一起过期，继续试只是白等；放弃后剩下的全部回退本地（有模型的话）。
  **单张「超时」不算连败**（`runBatchWithFailureLimit` 的 `isFatal`）：某张图的回包没按时
  解出来不代表整条腿挂了（2026-10-16 那次 8 张超时就把后面 35 张一起判了死刑），
  失败类型见 `OcrFailureKind`（`timeout` / `download_error` / `credential` / `other`）。
- **在线认过但一个字都没识别出来的图不再送本地**：图能取到、服务端也认过一遍了，本地
  多半同样是空。这种既不算成功也不算失败（`text: ''` 留在 `ocr.json` 里）。
- **`ocr.json` 一定写**（哪怕一张都没识别），形状稳定：

```json
{
  "generatedAt": "2026-10-16T…",
  "stats": { "total": 120, "ok": 43, "failed": 1, "online": 30, "local": 13,
             "timeouts": 0, "onlineOnly": 5, "filtered": 77 },
  "images": {
    "A1B2.jpg": {
      "text": "第一行\n第二行",
      "source": "oidb",
      "width": 1080, "height": 1920, "elapsedMs": 320,
      "blocks": [{ "text": "第一行", "quad": {…}, "rect": {…}, "parag": "…", "field2": 97 }]
    }
  }
}
```

**面板入口**（`ExportLightbox` 左列「图片识别」栏，单独一块、不在「扩展功能」里）：
OCR 开关的放行条件是「QQ 在线 或 本地识别模型已下载」；「在线识别」开关只在 QQ 在线 +
未开完全离线 + 物料齐全时出现。面板里**只提供筛图模型的下载**（下完自动 `setOcrModel`
设为当前模型）—— 筛图是在线 / 离线共有的前置步骤，放进来不会引出「要不要开在线」的
选择；出文字的识别模型统一在「设置 → 图片识别」里下（它是在线拿不到时的兜底）。
渲染层把「筛图模型当下下好没有」作为 `media.ocrPrefilter` 传给主进程（实时判定，
不进持久化预设），主进程据此把 `ocrfilter` 阶段标成 skipped 而不是空跑。

**进度与心跳**：`ocr` 阶段的分母 = 进识别腿的图（被筛掉的会从分母里减掉），分子 = 已经有
结论的图；在线阶段每 10 s 一条 `在线识别进行中：已定 x/y（成功 a · 失败 b · 超时 c · 在飞 d）`。
回包最慢要等 native 的 30 s 应答截止时间，没有这两样的话界面上就是一个不动的 0%。

**坑：应答体被压 zlib（`dataFlag=1`）**。服务端在应答体较大（几 KB 以上）时会把 SSO 层的
body 压成 zlib，native 层原先解不开就把整帧丢掉 —— 表现为「字越多的图越容易失败」，而且每个
请求要干等 30 s 才报超时（`client.rs` 的 `REPLY_TIMEOUT`）。native 侧已接上解压（`packer.rs`
的 `inflate_body`，不校验校验和，带 zlib 头 / 裸 deflate 都认）；导出侧另加了 45 s 单张兜底
（`main/ocr/online.ts`）并把这类失败单列成 `timeouts`，免得下次再从「没有可用的本地识别模型」
这种转译过的文案去猜。

**还没接的**：定时导出模板（`ScheduleOptions`）里没有 OCR 选项；频道私聊 / 群相册等其它
入口同理（跟着各自的时间表）。

### 打包（还没在真机安装包上验过）

- `extraResources`：`out/main/ocrWorker.mjs` 拷到 `<resources>/out/main/`（fork 出去的
  子进程读不了 asar 里的文件，语音那条线同理），并把 `node_modules/onnxruntime-node`
  与其运行时依赖 `onnxruntime-common` 整份拷到 `<resources>/node_modules/` —— worker
  从 `<resources>/out/main/` 起，模块解析正好能顺着往上找到它们。
- worker 是**自包含单文件**（rollup 已把管线打进去，没有相对 import）。为此主进程侧
  只允许**类型**引用 `pipeline.ts`，否则 rollup 会抽出一个共享 chunk，拷出去就少了文件。
- CI 里要按平台 × 架构验一遍（历史上 arm64 装错 binding 出过事，见 `release.yml`）。
  onnxruntime-node 的 npm 包**自带**全平台二进制，它的 postinstall 在 linux/x64 上还想
  拉 CUDA EP（几百 MB），已在 `pnpm-workspace.yaml` 里显式拒绝。

## 五、筛图模型实测（2026-10-16，扫本机 QQ 图片）

拿 `~/.config/QQ` 里 140 张真图（Pic / PhotoWall / Qzone 的 `Ori`，随机抽样）对了两遍：

| 判据 | 结果 |
| --- | --- |
| tiny 检测框 > 0 | 135 张算「有文字」，5 张「没有」 |
| v5 det（识别模型的检测头）框 > 0 | 134 张「有文字」，6 张「没有」 |
| 两者一致 | **133 / 140（95%）** |

不一致的 7 张很说明问题：

- tiny 说「有」、v5 说「没有」6 张 —— 其中 4 张是 240-420px 的正方形头像 / 表情类小图，
  tiny 给出**整图大小的框**（面积占比 60-100%）。这些是误报，靠「框面积占比上限」
  就能滤掉大半。
- v5 说「有」、tiny 说「没有」1 张 —— 254×240 的照片（约 17% 面积有字，低对比），
  tiny 漏了。**漏判是更危险的方向**（会把有文字的图跳过）。

所以「框 > 0」这个判据单用**偏松**。接线（导出侧）时建议：把筛图换成
`ch_PP-OCRv5_det_mobile`（4.6 MB，与识别模型同源、上面 134/140 那张表就是它），
或者留着 tiny 但加两条：框面积占比落在 **0.5% ~ 60%** 之间、且至少一个框置信度 ≥ 0.5。
**加档位是纯注册表改动**，UI 逐条渲染。

## 六、识别结果缓存（灯箱 / 导出 / MCP 共用一份）

同一张图在三个入口被反复识别是纯浪费（本地推理秒级、在线还有 9 天寿命与风控），所以
识别结果按**图片内容 md5** 存一份到 `<缓存根>/ocr/<md5 前两位>/<md5>.json`：谁先跑出来
谁写，后面所有人直接命中 —— 在线请求、本地推理、连筛图那一趟检测都省掉。设计取舍与
完整字段说明见[规划文档](./ocr-cache-plan-20261016.md)，实现是
[`packages/service/src/common/ocr_cache.ts`](../../packages/service/src/common/ocr_cache.ts)。

- **键**：元素 45424 / 45406（渲染视图里就是 `pic.md5`，`mapPic` 顺带把它归一成小写 hex）。
  MCP 给本机文件路径时也能对上 —— QQ 的图片文件名本来就叫 `<md5>.<ext>`。只认 16–64 位
  hex，认不出就不缓存（宁可少缓存，也别拿错一张图的文字）。
- **多份并存**：一条记录里按生产者分格（`oidb` / `local:<模型 id>` / 筛图
  `filters[<模型 id>]`），读的时候按调用方偏好挑。所以「离线时本地先跑过、之后在线可用」
  仍能拿到在线那份，换识别模型也不会吃到旧模型的结果；**空结果也算结果**（没文字），
  免得反复跑。
- **坐标系**：每份结果自带 `frame`（被识别那张图的宽高 + 原图 / 缩略图）。本地那条腿
  可能读到缩略图，覆盖层按它换算（`scaleOcrPoints` / `scaleOcrRect`）。
- **目录不进「清理缓存」白名单**（与 `roam-msg` / `weq-assistant` / `export` 同档）：
  过期图（CDN 已失效 + 本机没本体）的结果清掉就再也拿不回来，而体量很小。
- **灯箱门禁多一条腿**：`account.ocrCacheLookup({ md5 })` 命中时，「QQ 离线 + 没下模型 +
  服务端副本已过期」的图按钮照样能点，直接给缓存。

## 七、还差什么

1. **打包真机验证**：`pnpm build:unpack` 起一次，确认 `ocrWorker.mjs` +
   `resources/node_modules/onnxruntime-node` 的布局在安装包里成立（见第四节的说明）。
2. **取图**：本地 OCR 只解决「像素 → 文字」。字节来源要么本机 QQ 落盘，要么 rkey + CDN
   下载（需要在线 QQ），链路已在
   [`media_download.ts`](../../packages/service/src/account/media_download.ts)；
   所以「离线」只到推理这一步，纯离线只对已缓存 / 已落盘的图成立。
3. **入口门禁**：群相册 / 收藏 / 本地资源那些入口没带 `fileToken`，灯箱里依旧没有 OCR
   按钮。**「按文件路径取字节」的腿已经在 `local.ts` 里落地了**（MCP 的 `ocr_image_text`
   走 `path` 时就是它），要给这些入口开按钮，还差把它们手里的本地路径 / URL 喂进
   `runLocalOcr` 这一小步。
4. **导出侧的后续**：定时导出模板还没带 OCR 选项；筛图模型换档（把判据从 tiny 换成
   `ch_PP-OCRv5_det_mobile` 或加面积 / 置信度阈值）是纯注册表 + 几行判据的改动；OCR
   那条腿目前只在完整消息 / 频道私聊导出里跑。

## 八、已知的坑

- **精度差一档**：在线是腾讯自研（PP-OCR 血统 + 自有数据 + 更大 backbone）。mobile 档
  在普通聊天截图上接近，小字 / 艺术字 / emoji 混排 / 竖排 / 手写会明显更差；想追平要上
  server 档（体积大 3–5 倍，CPU 慢好几倍）。
- **方向**：cls 只能纠 180°（倒转），不是任意角度旋转。
- **打包**：新增原生依赖要在 `electron-builder.yml` 与 `release.yml` 里按平台 × 架构
  逐项校验（历史上 arm64 装错 binding 出过事）。
- **与在线版共存**：两者输出契约一致，可以「在线优先、本地兜底」，也可以只用本地 ——
  和语音转写「在线漏包回退本地模型」是同一个思路。

---

[← 返回开发者入口](./index.md)
