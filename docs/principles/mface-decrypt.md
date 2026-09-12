# 商城表情的解密

商城表情（marketface）的图片在**本地缓存与部分 CDN 流上都是加密的**。本页讲三件事：

1. 本地缓存文件的 XOR 混淆与直接解法（**无需任何密钥**）；
2. CDN 加密流的 QQTEA 解密——密钥就是消息里自带的 `encryptKey`（80824）；
3. `encryptKey` 缺失时的兜底：按时间戳派生密钥 / 爆破。

对应 WeQ 实现：

| 文件 | 职责 |
| ---- | ---- |
| `packages/service/src/account/emoji.ts` | 本地 XOR 解密、QQTEA 解密、CDN 下载链路（`getMarketFace` / `getMarketPackImage`）、密钥派生 |
| `packages/native`（Rust `nt_helper`） | `getMarketFaceKey`：读种子 / `updateTime` 附近爆破（接口见 [nt-helper-interface](../develop/nt-helper-interface.md)） |
| `packages/service/src/account/market_emoji_resource.ts` | 本地商城表情库浏览（枚举 + 类型探测） |

消息里 mface element 的字段本身见 [mface 消息段](../database/nt_msg/elements/mface.md)。

---

## 一、本地缓存：XOR 混淆，无需密钥

QQ NT 把商城表情下载到 `nt_data/Emoji/marketface/<itemId>/<hash>`（`itemId` = 表情包
id，`hash` = 表情文件名）。其中**加密 GIF 的混淆规则**非常简单：

> 每 50 字节一块，块内**前 20 字节与 `0xFF` 异或**，其余 30 字节原样保留。

```ts
// packages/service/src/account/emoji.ts · decrypt()
for (let i = 0; i < input.length; i += 50) {
  const chunkSize = Math.min(50, input.length - i);
  const head = Math.min(20, chunkSize);
  for (let j = 0; j < head; j++) output[i + j] = input[i + j] ^ 0xff;
  if (chunkSize > 20) input.copy(output, i + 20, i + 20, i + chunkSize);
}
```

解开后应以 `GIF89a` / `GIF87a` 开头。**同一目录里还有明文 PNG**，命名规则：

| 文件名 | 内容 | 处理 |
| ------ | ---- | ---- |
| `<hash>`（无扩展名） | XOR 混淆的 GIF | 需要上面的 XOR 解密 |
| `<hash>_aio.png` | 全尺寸明文 PNG | **原样使用，绝不能 XOR** |
| `<hash>_thu.png` | 缩略图明文 PNG | 同上 |
| `<hash>.png` | 偶尔出现的裸明文 PNG | 同上 |

最大的坑就在这里：**混淆的 GIF 和明文 PNG 混在同一目录**，把 PNG 也「解密」一遍只会
得到乱码。WeQ 的 `getMarketFace` 链路按 `GIF 优先 → PNG 兜底` 的顺序取用：

1. WeQ 自己的解密缓存（`cache/marketface/<hash>.gif` / `.png`）；
2. QQ 本地缓存：`<hash>` 无扩展名 → XOR 解密落盘；`<hash>_aio.png` 等明文 PNG → 原样拷贝；
3. 都没有 → CDN 明文兜底（见下）。

## 二、CDN：QQTEA 加密流，密钥 = `encryptKey`（80824）

### CDN 的两种形态

同一个 hash 在 CDN `i.gtimg.cn/club/item/parcel/item/<hash前2位>/<hash>/` 下有：

| 资源 | 加密与否 | 说明 |
| ---- | -------- | ---- |
| `raw300.gif` / `raw200.gif` | **明文** | 聊天渲染链路用的就是它 |
| `300x300.png` / `200x200.png` | 明文 | PNG 兜底 |
| `300_300` / `200_200` | **QQTEA 加密** | 表情包浏览器链路（下载到本地才解密） |

聊天消息里的贴纸**不需要任何解密**：element 里的 CDN URL 指向明文 raw GIF。需要解密的
是「表情包浏览器」那条链路——按包下载 `300_300` / `200_200` 加密流时。

### QQTEA 解密流程

密钥就是 mface element 自带的 `encryptKey`（80824，string）：

> `encryptKey` 是 16 字节 ASCII 串，形如 `md5(时间戳字符串)[:16]`。
> **渲染聊天记录完全不需要爆破**——除非旧消息此字段为空。

```text
1. key = encryptKey 的 16 个 ASCII 字节
2. 逐 8 字节块做 16 轮大端 TEA 解密（交织链式 CBC）：
   明文_i = Dec(密文_i XOR 上块中间值) XOR 上块密文
3. 去头：第 1 字节是控制位，控制位 & 7 = 填充长度，再跳过 2 字节 salt
   （即 body = out[1 + pad + 2 :]）
4. 去尾：截到最后一个 GIF trailer 0x3b
5. 校验：结果应以 GIF89a / GIF87a 开头
```

TEA 解密在 `emoji.ts` 里有完整 TS 实现（`qqteaDecrypt`，与 `packages/native` 的
rust 版对齐），也由离线单测覆盖。

下载时的防御细节：`ct.length % 8 !== 0` 或首字节 `0x3c`（`<`，CDN 错误页）直接跳过；
解密后魔数不对（密钥错）→ 换下一档分辨率重试，再不行放弃。

## 三、密钥派生与爆破（`encryptKey` 为空时）

密钥公式只有一个：

```text
key = md5( String(seed) )[: 16 ]     // seed 是 unix 秒级时间戳
```

所以「找密钥」等价于「找 seed」。WeQ 的 `getMarketFaceKey(packetId)`（native，自包含）
按三条路线依次尝试：

### 1. xydata 快路径（免费 / VIP 包）

拉包元数据 `https://i.gtimg.cn/club/item/parcel/<packId % 10>/<packId>_android.json`，
其中部分包直接带了种子时间戳——读出来按公式派生即可，零成本。

`android.json` 还顺带给出包名、介绍、**`feetype` 收费类型**（1 免费 / 2 付费 / 4 VIP /
5 SVIP，实测只有 2/4/5 是真付费门禁）和 `updateTime`（上架时间）。

### 2. updateTime 附近爆破（付费包）

付费包的元数据不带种子。但 seed 是**生成加密 GIF 时的时间戳**，必然落在包的
`updateTime`（上架时间）附近的一个窗口里：

```text
for ts in updateTime ± 窗口:
    key = md5(str(ts))[:16]
    TEA 解密密文的前两个块
    若明文开头是 "GIF8" → 命中
```

验证用**已知明文**：加密 GIF 解对后开头必然是 `GIF8`，只需解前 2 块（16 字节），
单个候选是微秒级的。窗口耗尽仍无命中 → 返回 null（未知包 / 网络失败 / 时间戳离得太远）。

### 3. 手动输入

前端允许用户手动给一个时间戳，`EmojiService.getMarketPackKey(packId, timestamp)` 直接
本地派生（`source: 'manual'`），不查网络、不缓存——用户会反复试不同的值。

### 缓存

native 恢复快且结果稳定，`EmojiService` 按 packId 在会话内缓存恢复结果（含 in-flight
去重），避免同一个包反复爆破。

---

## 四、小结

| 场景 | 加密 | 解法 |
| ---- | ---- | ---- |
| 聊天里的 mface（CDN raw GIF） | 明文 | 直接下载 |
| 本地缓存 `<hash>`（无扩展名） | XOR 0xFF（每块前 20 字节） | 无需密钥，本地即可解 |
| 本地缓存 `*_aio.png` / `*_thu.png` | 明文 | 原样使用，**不要 XOR** |
| 表情包浏览器 CDN `300_300` / `200_200` | QQTEA | `encryptKey`（80824）；缺失时按 `md5(str(seed))[:16]` 派生，seed 读元数据或 updateTime 附近爆破 |

---

[← 返回原理总览](./index.md)
