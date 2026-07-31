# elementType 2 — 图片

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 2`）。

图片是「文件族」中字段最全的一类，绝大多数 `454xx / 455xx / 458xx` tag 都能在图片行上看到。
文件族的**共用字段**（文件名 / 大小 / MD5 / 三档 URL 与本地路径 / CDN 信息 / 传输标记）
统一在 [40800 总览 · 第五节](../40800.md#五跨类型共用的文件族字段) 说明，本页不重复。

---

## 一、subType — 图片的来源分类

名字取自 QQ NT 自身的 `PicSubType` 枚举。实践中 0 / 1 最常见，2/3/4/7 也确有出现；
另有 10..14 出现在野外，超出厂商枚举范围，未命名（需要有渲染结果才能确认）。

| 值 | 名称 | 说明 |
| -- | ---- | ---- |
| 0 | NORMAL | 普通图片 |
| 1 | CUSTOM | 自定义表情（收藏的表情包） |
| 2 | HOT | 热图 |
| 3 | DIPPER_CHART | 斗图 |
| 4 | SMART | 智能图 |
| 5 | SPACE | 空间图（未观测） |
| 6 | UNKNOW | 厂商枚举里就叫 `KUNKNOW`（未观测） |
| 7 | RELATED | 关联图 |

## 二、`imgType`（45416）

| 值 | 名称 | 说明 |
| -- | ---- | ---- |
| 1000 | NORMAL | 普通图 |
| 1001 | ORIGINAL | 原图 |
| 2000 | EMOJI | 表情 |

## 三、必有字段

依据 `element/spec.ts` 的 `PicElementSchema`，一个图片 element 一定带这些字段：

| tag | 字段名 | 类型 | 说明 |
| --- | ------ | ---- | ---- |
| 45402 | `fileName` | string | 图片文件名 |
| 45405 | `fileSize` | uint32 | 字节数 |
| 45406 | `md5Bytes` | bytes | 二进制 MD5 |
| 45408 | `contentHash` | bytes | 内容校验 hash |
| 45411 | `imgWidth` | uint32 | 宽（像素） |
| 45412 | `imgHeight` | uint32 | 高（像素） |
| 45416 | `imgType` | uint32 | 见上表 |
| 45418 | `isOriginal` | bool | 是否原图 |
| 45424 | `md5` | string | 大写十六进制 MD5 |
| 45503 | `fileToken` | string | 下载凭据 |
| 45505 | `uploadTime` | uint32 | 上传 / 处理时间戳 |
| 45517 | `uploadTimestamp` | uint32 | 上传时间戳 |
| 45518 | `fileTTL` | uint32 | 有效期（秒） |
| 45802 | `thumbnailUrl` | string | 缩略图 URL |
| 45803 | `previewUrl` | string | 预览图 URL |
| 45804 | `originalUrl` | string | 大图 URL |
| 45815 | `summary` | string（repeated） | 摘要 / 描述 |
| 45816 | `cdnHost` | string | CDN 域名 |

## 四、可选字段

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 45403 | `filePath` | string | 本地文件路径 |
| 45511 | `picTransferState` | uint32 | 传输状态 |
| 45513 | `transferVersion` | uint32 | 传输版本 |
| 45806 | `cdnServerIp` | uint32 | CDN 地址，大端打包 IPv4 |
| 45807 | `cdnServerPort` | uint32 | CDN 端口 |
| 45812 | `thumbnailLocalPath` | string | 缩略图本地缓存路径（`…_0.jpg`） |
| 45813 | `previewLocalPath` | string | 预览图本地缓存路径（`…_198.jpg`） |
| 45814 | `originalLocalPath` | string | 大图本地缓存路径（`…_720.jpg`） |
| 45507 | `transferFlag45507` | int64 | 近似常量哨兵，见总览 |
| 45509 | `transferFlag45509` | uint32 | 恒为 1（与 45507 成对） |
| 45600 | `picFlag45600` | bytes | 复杂嵌套结构（图片冗余信息），保留为原始字节 |

## 五、观测到但语义未验证

以下 tag 在图片行上出现过，但取值几乎恒定，携带不了可利用的信息，仅为往返保真而解析。

| tag | 观测情况 |
| --- | -------- |
| 45425 | 只在 subType=13 的行上出现，取值 1（×93）/ 2（×2） |
| 45801 | 唯一一次观测为空字符串 |
| 45557 | 唯一一次观测为 0 |
| 45805 | 所有观测行恒为 0 |
| 45817 | PIC 协议标志（uint32） |
| 45818 / 45819 / 45820 | string，语义未知 |
| 45821 / 45822 / 45823 | uint32，语义未知 |
| 45824 | string，语义未知 |
| 45825 / 45826 / 45827 | uint32，语义未知 |
| 45828 | string，语义未知 |
| 45829 / 45830 / 45831 | 恒为 0 |

---

[← 返回消息段索引](../index.md#消息段element索引)
