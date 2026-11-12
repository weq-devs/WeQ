# gpro 频道库密钥

QQ 频道（Guild）用一套独立的库：`gpro_v1-6_<uid>.db`，和 `nt_msg.db` 放在同一个
`nt_db` 目录里。**它不能按消息库那套解密** —— 头部的随机串长度和位置都不一样，派生公式也不同。

本页只记结论；想直接算，用[在线计算器](/tools/db-key#gpro-频道库)。

## 一、结论

```text
user_seed   = md5( md5(uin) + md5( sha1(uin) 的原始字节 ) )
header_seed = md5( 头部 16 字节随机串 )
db_key      = md5( header_seed + user_seed )
```

三个必须注意的点：

1. **参与运算的是 QQ 号（uin），不是文件名里的 uid。** 文件名 `<uid>` 只是给人看的。
2. `sha1(uin)` 取的是**原始 20 字节**，不是 hex 字符串。这一步弄错，结果会是一串看起来
   很像但完全解不开的 hash。
3. 头部随机串是**前 16 个可打印字符**，位于 1024 字节私有头里。

已知测试向量（可用来核对实现）：

| 输入 | 值 |
| --- | --- |
| uin | `1707889225` |
| 头部随机串 | `vgdBdzWwwrNNGORk` |
| 结果 | `2a4e04f77fd4ab2f4a42717e3e69e3d3` |

## 二、算法组合也和消息库不同

| 参数 | 常见消息库 | gpro 频道库 |
| --- | --- | --- |
| 私有头 | 1024 字节 | 1024 字节 |
| Page size | 4096 | 4096 |
| KDF 迭代 | 4000 | 4000 |
| KDF 算法 | `PBKDF2_HMAC_SHA512` | `PBKDF2_HMAC_SHA512` |
| **页 HMAC** | **`HMAC_SHA1`** | **`HMAC_SHA512`** |

这就是「密钥算对了还是打不开」的典型原因：口令对了，但页 HMAC 用了默认的 SHA1。
WeQ 的 `testDatabaseKey` 会穷举 12 种组合，`getGuildDbKey(dbPath, uin)` 直接给出这个库的密钥。

::: warning

不要用「跑一次能开就算」来判断实现正确 —— 页 HMAC 用错时，某些库能读出首页、后面才报
`NOTADB`。判断标准是 `checkDatabaseHealth` 能过。

:::

## 三、库里有什么

频道账号自己的资料和部分频道消息。**真正的频道消息在 `guild_msg.db`**，gpro 库更像频道
模块的配置与索引。表结构还没人系统整理，`WeQ` 目前只用它做频道相关读取。

## 相关

- [数据库解密流程](db-decrypt.md) —— 通用取密钥与读库流程
- [手机数据库密钥计算](/tools/db-key) —— 顺手把 gpro 密钥也算出来
