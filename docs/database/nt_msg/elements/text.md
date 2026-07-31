# elementType 1 — 文本 / @

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 1`）。

文本是最常见的消息段。**@ 提及并不是独立的 elementType**，它同样是 `elementType = 1`，
靠额外字段区分。

---

## 一、text 与 at 的区分

WeQ 在 `element/registry.ts` 里的判据只有一句：

```ts
const kind = wire.bubbleId ? 'at' : 'text';
```

即：**`45105` 有值就是 @，没值就是普通文本**。

@ 元素上三个字段的实际用途（注意字段名是历史遗留，与聊天「气泡」无关）：

| tag | 字段名 | @ 元素中装的东西 |
| --- | ------ | ---------------- |
| 45101 | `textContent` | 展示文本，形如 `@某人 `（末尾带一个空格） |
| 45105 | `bubbleId` | **被 @ 者的 uid** |
| 45103 | `textEncodingFlag` | **被 @ 者的 uin**（QQ 号） |

`@全体成员` 同样走这条路径，只是 uid / uin 为特殊值。

## 二、subType — 是链接安全分级，不是文字样式

`45003 (subType)` 在文本上的语义容易误解：它**不表示字体或样式**，而是 QQ 对链接的安全分类。
全表扫描的结论是：`subType > 0` 只出现在内容是 / 含 URL 的消息上。

| 值 | 名称 | 说明 |
| -- | ---- | ---- |
| 0 | PLAIN | 普通文本，不含链接 |
| 1 | EXTERNAL_LINK | 外部链接。会附带 `45112 (urlVerifyFlag)` —— QQ 扫描域名后附的 12 / 24 / 248 字节安全校验负载 |
| 2 | TRUSTED_LINK | 可信链接（腾讯系域名：`docs.qq.com` / `mp.weixin.qq.com` …）。**不带 45112**，QQ 对自家域名跳过安全检查 |

## 三、字段

### 核心

| tag | 字段名 | 类型 | 必有 | 含义 |
| --- | ------ | ---- | ---- | ---- |
| 45101 | `textContent` | string | ✅ | 文本内容 |
| 45102 | `textReserve` | uint32 | | 文本信封标志。构造 @ 时 WeQ 写 2 |

### 观测到但语义未验证

以下字段在真实文本行上出现过，会被解析（这样 tag 字典能给它们名字），但既不会被提升进
`TextElement` 的渲染路径，也不参与回写。含义列均为**推测**，无一验证。

| tag | 字段名 | 类型 | 推测含义 |
| --- | ------ | ---- | -------- |
| 45103 | `textEncodingFlag` | uint32 | 文本编码 / 加密标志。**@ 元素中确定装的是被 @ 者 uin** |
| 45104 | `fontStyle` | uint32 | 字体 / 样式相关 |
| 45105 | `bubbleId` | string | 气泡 ID。**实际用途见上：@ 的目标 uid** |
| 45106 | `textInputState` | uint32 | 文本输入状态 |
| 45108 | `translationFlag` | uint32 | 翻译 / 转换标志 |
| 45109 | `linkDetectionFlag` | uint32 | 链接识别标志 |
| 45110 | `atMentionMask` | string | @ 相关位掩码（字符串编码） |
| 45111 | `walletFlag` | uint32 | 红包 / 钱包含义标志 |
| 45112 | `urlVerifyFlag` | bytes | 网址校验字段，见上方 subType=1 |

> `45107` 至今未观测到。

---

[← 返回消息段索引](../index.md#消息段element索引)
