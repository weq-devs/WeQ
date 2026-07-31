# elementType 11 — 商城表情

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 11`）。

商城表情（marketface / 商业贴纸）。它使用**完全独立的 `808xx / 809xx` tag 段**，
与其它所有 element 类型都不重叠。

---

## 一、已理解的字段

| tag | 字段名 | 类型 | 必有 | 含义 |
| --- | ------ | ---- | ---- | ---- |
| 80810 | `emojiPackId` | uint32 | ✅ | 表情包 ID |
| 80900 | `emojiDesc` | string | ✅ | 表情描述文字，如 `[嗨]` |
| 80901 | `mfaceType` | uint32 | ✅ | 表情类型 |
| 80902 | `mfaceSubType` | bool | ✅ | 表情子类型标志 |
| 80903 | `marketEmoticonId` | bytes | ✅ | **真正的贴纸 id**，也是磁盘上的文件名 |
| 80905 | `mediaType` | uint32 | ✅ | 媒体类型标志 |
| 80908 | `renderFlag` | bool | ✅ | 渲染标志 |
| 80909 | `previewWidth` | uint32 | ✅ | 预览图宽 |
| 80910 | `previewHeight` | uint32 | ✅ | 预览图高 |
| 80935 | `isAnimated` | bool | ✅ | 是否动图 |
| 80824 | `encryptKey` | string | | **本地 / CDN 加密表情图的解密密钥** |

## 二、`encryptKey`（80824）—— 渲染无需爆破

商城表情的图片文件（本地缓存与 CDN 上）都是**加密**的。关键结论是：

> 消息 element 里自带的 `encryptKey` 就是 QQTEA 的 16 字节密钥
> （形式为 `md5(时间戳)[:16]` 的 ASCII 串），拿它直接就能解密。

这意味着渲染聊天记录里的商城表情**完全不需要爆破时间戳**。
只有 `encryptKey` 为空的旧消息，才退化到「靠 `emojiPackId` 去 CDN + 爆破」的路子。

CDN 地址由 `marketEmoticonId` 的十六进制串拼出：

```text
https://i.gtimg.cn/club/item/parcel/item/<hash前2位>/<hash>/<300_300 或 200_200>
```

解密流程（QQTEA，交织链式 CBC）：

1. 取 `encryptKey` 的 16 个 ASCII 字节作为 TEA key；
2. 按 8 字节分块做 16 轮大端 TEA 解密，前后块交织异或；
3. 去头：第 1 字节是控制位，`控制位 & 7` 得到填充长度，再跳过 2 字节 salt；
4. 去尾：截到最后一个 GIF trailer `0x3b`；
5. 结果应以 `GIF89a` / `GIF87a` 开头。

端到端验证脚本：`packages/db/tools/mface_tea_decrypt.ts`
（`pnpm --filter @weq/db test:mface-tea-decrypt`）。

> 📌 详细原理另见 [商城表情的解密](../../../principles/index.md)（编写中）。

## 三、语义未验证的字段

以下 `808xx/809xx` tag 仅为往返完整性而解析，wire 类型是**依字段标签猜的**，
含义均未验证。

| tag | 字段名 | 类型（推测） | 推测含义 |
| --- | ------ | ------------ | -------- |
| 80907 | `mfaceFlag80907` | bytes | 空对象 |
| 80913 | `mfaceFlag80913` | bytes | 扩展元数据 |
| 80941 | `mfaceFlag80941` | bytes | 样式 / 空对象 |
| 80942 | `mfaceFlag80942` | bytes | 样式 / 空对象 |
| 80970 | `sizeInfo` | bytes | protobuf 编码的宽高，如 `e0 c1 27 c8 01 e8 c1 27 c8 01` |
| 80975 | `mfaceFlag80975` | uint32 | 兼容性标志 |
| 80977 | `mfaceFlag80977` | bytes | 样式 / 空对象 |
| 80978 | `mfaceFlag80978` | string | 颜色 / 样式代码 |
| 80980 | `mfaceFlag80980` | uint32 | 权限标志 |
| 80981 | `mfaceFlag80981` | uint32 | 权限标志 |
| 80983 | `mfaceFlag80983` | string | 扩展 JSON |
| 80995 | `mfaceFlag80995` | uint32 | 结束 / 填充标志 |

---

[← 返回消息段索引](../index.md#消息段element索引)
