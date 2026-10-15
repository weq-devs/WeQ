# 本地文字识别（OCR）模型

> 现状：**本地引擎已经接上灯箱了** —— 聊天图片的「OCR」按钮在线优先（OIDB 0xe07_0）、
> 在线不可用或失败时回退本地模型（见第四节）。**导出侧的批量自动 OCR 还没接**，
> 筛图模型目前只在设置页里可选、下载。
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

## 六、还差什么

1. **导出侧自动 OCR**：勾选后先用筛图模型过一遍（跳过没有文字的图），再送识别模型；
   结果回写到导出文件里，照语音转写那套「先落盘、转写完成再回写」的机制
   （`packages/service/src/account/export/media_export.ts`）。这一轮**没接**。
2. **打包真机验证**：`pnpm build:unpack` 起一次，确认 `ocrWorker.mjs` +
   `resources/node_modules/onnxruntime-node` 的布局在安装包里成立（见第四节的说明）。
3. **取图**：本地 OCR 只解决「像素 → 文字」。字节来源要么本机 QQ 落盘，要么 rkey + CDN
   下载（需要在线 QQ），链路已在
   [`media_download.ts`](../../packages/service/src/account/media_download.ts)；
   所以「离线」只到推理这一步，纯离线只对已缓存 / 已落盘的图成立。
4. **入口门禁**：群相册 / 收藏 / 本地资源那些入口没带 `fileToken`，灯箱里依旧没有 OCR
   按钮；要给它们开 OCR，得先有一条「按文件路径取字节」的腿（`localfile` 那条已经在）。

## 七、已知的坑

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
