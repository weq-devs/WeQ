# 商城表情：密钥与图片解密

商城表情（marketface）有两条完全不同的链路，混淆点就在这里：

| 来源 | 加密 | 怎么处理 |
| --- | --- | --- |
| 聊天消息里的贴纸（CDN `raw300.gif`） | 明文 | 直接下载 |
| 本地缓存 `<hash>`（无扩展名） | XOR 混淆，**无密钥** | 本页第二个工具 |
| 本地缓存 `<hash>_aio.png` / `_thu.png` | 明文 PNG | 原样使用，**不要 XOR** |
| 表情包浏览器下载的 CDN `300_300` / `200_200` | QQTEA | 本页第一个工具算出的密钥 |

## 密钥：`md5(时间戳)`

密钥没有别的来源，就是 `md5(String(seed))` 的前 16 位，`seed` 是生成加密 GIF 时的 unix 秒。
消息里带着 `encryptKey`（80824）时直接就有；只有旧消息缺这个字段时才需要找回时间戳。

<MarketFaceKeyCalculator />

常见找回顺序：

1. 拉包元数据 `https://i.gtimg.cn/club/item/parcel/<packId % 10>/<packId>_android.json`，
   免费 / VIP 包有时直接带种子时间戳；
2. 付费包的元数据不带种子，但 seed 一定落在**上架时间 `updateTime` 附近**，用上面的候选表
   逐条试，能解出 `GIF8` 开头的那条就是；
3. 还不行就手动试一个时间戳。WeQ 的表情包浏览器支持直接输入。

::: tip

解的是「表情包浏览器」那条链路。**渲染聊天记录根本不需要密钥** —— 消息里的 CDN 地址指向
明文 GIF。

:::

## 本地缓存图片解密

<MarketFaceImageDecoder />

规则很简单：**每 50 字节一块，块内前 20 字节与 `0xFF` 异或**，其余 30 字节原样保留。
解开后应以 `GIF89a` / `GIF87a` 开头。

最大的坑是同目录里混着明文 PNG —— 把 `_aio.png` 也「解密」一遍只会得到乱码。工具会先看
文件头，认得出是明文就原样显示。

## 相关

- [mface 消息段](/database/nt_msg/elements/mface) —— element 里的字段含义
- [商城表情的解密](/develop/principles/mface-decrypt) —— 完整链路
- [表情与装扮资源](/guide/emoji-resources) —— WeQ 里的浏览入口
