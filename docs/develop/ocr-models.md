# 本地文字识别（OCR）模型

> 现状：**只做模型的下载与存储**（设置 → 图片识别）。本地的识别引擎（onnxruntime）
> 与导出侧的自动识别是单独一轮的事。
>
> 这一轮落地的代码：注册表 [`packages/service/src/common/ocr_models.ts`](../../packages/service/src/common/ocr_models.ts)、
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
接线时要用真实截图定阈值（框数量 / 框面积占比），或者把筛图换成
`ch_PP-OCRv5_det_mobile`（4.6 MB，更稳）。**加档位是纯注册表改动**，UI 逐条渲染。

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

## 四、下一轮（接线）要做的

1. **引擎**：`onnxruntime-node`（各平台有预编译包）。打包要 `asarUnpack` +
   `extraResources` + CI 架构校验，照 sherpa / resvg 的流程抄。主要工作量在 det 后处理
   （二值化 / 连通域 / `unclip` / 最小外接矩形）与 rec 解码（长宽比裁剪 + 高度归一 +
   CTC + 字典），RapidOCR 有公开实现可参考。
2. **产出**：与在线版同构的 blocks（`text` / `quad` / `rect` / `parag` / 置信度）。
   坐标就是输入图的像素坐标；det 内部 resize 的 scale 要映射回原图（协议里现成的
   `scaleOcrRect` / `scaleOcrPoints` 可直接复用）。
3. **隔离**：app 侧 fork 子进程跑原生推理，照
   [`apps/desktop/src/main/transcribe/worker.ts`](../../apps/desktop/src/main/transcribe/worker.ts)
   —— 引擎崩了只死一个 worker，不带崩主进程。
4. **导出侧自动 OCR**：勾选后先用筛图模型过一遍（跳过没有文字的图），再送识别模型；
   结果回写到导出文件里，照语音转写那套「先落盘、转写完成再回写」的机制。
5. **取图**：本地 OCR 只解决「像素 → 文字」。字节来源要么本机 QQ 落盘，要么 rkey + CDN
   下载（需要在线 QQ），链路已在
   [`media_download.ts`](../../packages/service/src/account/media_download.ts)；
   所以「离线」只到推理这一步，纯离线只对已缓存 / 已落盘的图成立。

## 五、已知的坑

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
