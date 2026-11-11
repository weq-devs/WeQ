# 数据库密钥计算

桌面端 QQ 的库口令由 WeQ 通过内存扫描或协议在线拿到；**手机 QQ 的库不一样 —— 口令可以
完全离线算出来**，不需要 root、不需要越狱、也不需要 hook。

下面两个公式都是「输入都来自文件本身」，所以拿到库文件就能验算。

## 手机消息库（Android / iOS）

输入两个值：账号 uid 和库头部那 8 位可打印字符串 `rand`。

<AndroidDbKeyCalculator />

- `rand` 在 `nt_msg.db` 前 1024 字节私有头里，紧跟 `QQ_NT DB` 标记之后，明文可读。
- uid 的获取方式（任选其一）：`files/uid/` 目录下的文件名
  `<uin>###<uid>`；或 `beacon_db` 文本里 `"home_uin": "...","uid":"..."`；
  或 `gpro_v1-6_<uid>.db` 的文件名。
- 算出来的 `nt_qq_<QQ_path_hash>` 就是手机上的账号目录名。

::: warning

iOS 的公式与 Android 完全一致，但**桌面端（Windows / Linux / macOS）不适用**：
桌面库的口令是 32 位 hex 的 raw key，由 QQ 进程内存里的会话物料得来，不能从文件头推出来。

:::

## gpro 频道库

QQ 频道的数据库 `gpro_v1-6_<uid>.db` 和消息库同目录，但密钥是另一套派生 ——
文件名带 uid，**参与运算的却是 QQ 号**。

<GproKeyCalculator />

盐值是库文件开头 1024 字节私有头里的 16 个可读字符。频道库的算法组合也和常见消息库不同
（页 HMAC 是 `HMAC_SHA512`），用错组合会直接解密失败。

::: danger

两个公式都会产出**能解开真实数据库的口令**。请只在自己的数据上使用，不要把算出的密钥、
库文件或导出内容发到公开的地方。

:::

## 相关

- [数据库解密流程](/develop/principles/db-decrypt) —— 桌面端怎么取密钥、算法怎么探测
- [gpro 频道库密钥](/develop/principles/gpro-database) —— 结论、算法差异与测试向量
- [login.db 在线检查](./login-db.md) —— 先确认手上的库是什么布局
