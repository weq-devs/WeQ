# 数据库解密流程

NTQQ 的数据库是 **SQLCipher v4**，文件开头还叠了一段 QQ 自己加的包装头。
WeQ 不去改库、不改 QQ 进程内存，而是拿到 raw master key 之后通过一个
**offset VFS** 透明跳过文件头，把「已解密的库」直接当普通 SQLite 读。

本篇讲清三件事：密钥从哪来、算法怎么定、读的时候怎么绕过包装头。
具体接口签名见[nt_helper.node 接口文档](/develop/nt-helper-interface)。

## 一、文件布局

一个 QQ 库文件大致是：

```
偏移 0x000 ┌─────────────────────────┐
           │  QQ 包装头（1024 字节）  │  不参与 SQLCipher 分页
偏移 0x400 ├─────────────────────────┤
           │  SQLCipher 第 1 页       │  含 16 字节 salt（前 16 字节）
           │  ...                     │
           └─────────────────────────┘
```

这 1024 字节不是 SQLCipher 规范的一部分，是腾讯加的。标准 SQLite 工具打开
QQ 库会直接报 `file is not a database`，原因就在这一段。

因此 WeQ 的做法是**不改文件**：native 侧注册一个 offset VFS，把逻辑偏移整体
平移 1024 字节，SQLite 看到的就是一个从 0 开始的正常库。

> 包装头长度不是硬编码的全局常量。`login.db` 等库的布局不同，nt_helper 会从
> 文件头自动识别，同一进程可以同时打开 QQ 布局与标准布局两类库，不需要子进程。
> 保留页按文件设置：QQ 布局保留 `262144`，标准布局保留 `262145`。

## 二、密钥从哪来

raw master key 是 16 字节，不是用户密码。WeQ 有多条获取路径，按可用性排序：

| 路径 | 前提 | 特点 |
| --- | --- | --- |
| 纯协议 `quickLogin` / `qrLogin` | `login.db` 里有缓存的 a1 + 设备 guid | **不读内存、不注入、不提权**，登录服务器换票据后顺带发 OIDB `0xcde_2` 取 `dbKey` |
| `scanKeyFromDatabase` | QQ 正在运行 | 零注入内存扫描，先用 `dbPath` 过滤候选，锚点/簇扫描失败时回退全内存扫描 |
| 离线计算 | Android 等外部来源 | 不依赖本机 QQ 进程 |

主推第一条：它对 QQ 进程零影响，用户也不需要重启 QQ 或预先登录。
内存扫描是 QQ 在线时的补充手段，不是首选。

扫描出来的候选**必须校验**：不是所有 16 字节串都是密钥。校验方式是拿候选去
试解库，能通过页 HMAC 的才算数 —— 见下一节。

## 三、算法组合：page-HMAC × KDF-HMAC

SQLCipher v4 有两个独立的 HMAC 用途，容易混：

- **KDF-HMAC**：PBKDF2 派生密钥时用什么摘要
- **page-HMAC**：每页的完整性校验用什么摘要

两者在 QQ 的不同库上**可以不一致**。实测 `gpro` 频道库是
`KDF=PBKDF2_HMAC_SHA512` + `page=HMAC_SHA1`，而另一批库是
`page=HMAC_SHA512`（对比见 [gpro 频道库密钥](gpro-database.md)）。

所以 `CipherAlgo` 是一个二元组：

```js
{ pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA1' }
// page: 'none' | 'SHA1' | 'SHA256' | 'SHA512'
// kdf : 'SHA1' | 'SHA256' | 'SHA512'
```

`pageHmacAlgorithm: 'none'` 是一档特殊值 —— 库没开页 HMAC，此时**不能**
把「坏页清单为空」当成「库是好的」，只是这张地图没意义。

不知道算法时先用 `testDatabaseKey` 探测，它会穷举 **12 种组合**
（4 种 page × 3 种 KDF），返回能解开的那一组。

## 四、读库

拿到 `(raw key, algo)` 之后：

1. 首次 `executeSqlWithKey(dbPath, sql, key, algo)` —— 驱动 PRAGMA 序列并把连接缓存下来；
2. 之后同一 `dbPath` 直接用 `executeSql(dbPath, sql)`，不必再传密钥；
3. 登出或释放句柄时 `closeDb(dbPath)`。

密钥**只消费一次**，连接复用是默认行为。这也是 `better-sqlite3` 在运行时代码里
零引用的原因：所有读库都走 native 这一条路，避免两套连接管理。

## 五、解密落盘

需要一份「任何 SQLite 工具都能打开」的明文库时，有两个接口：

| 接口 | 做法 | 适用 |
| --- | --- | --- |
| `fastDecryptDatabase` | 直接按页解密落盘 | 快，但导出期间 QQ 若 checkpoint 可能撕页 |
| `safeDecryptDatabase` | 读走 SQLite，`sqlcipher_export` 导出 | 长导出不怕并发写，无中间文件 |

两个产物都是**标准布局**（不带 QQ 那 1024 字节头）。

> 大库有内存风险。调用前应走 `selectDatabaseDecryptMethod(dbPath, mode)`，
> 它会把 ≥ 512 MiB 的快速解密请求切换成安全模式 —— 快速接口整库分配内存，
> 在 Electron 里足以把进程打死，worker 线程也隔离不了原生内存分配失败。

## 六、库坏了怎么办

QQ 库偶尔会有物理坏页（`SQLITE_CORRUPT` / `SQLITE_NOTADB`）。
WeQ 的处理分三档，逐级放宽：

1. **严格**：正常连接，坏就报错。
2. **宽容（salvage）**：`executeSqlSalvage*` 不因损坏抛异常，返回 `ok:false` + 错误码，
   由调用方决定放弃还是缩小范围；级别 ≥ 1 时换访问路径（`NOT INDEXED`）重试。
3. **分块扫描**：`executeSqlSalvageScan*` 读不出的块先换路径、再二分到 `minSpan`，
   仍坏就记成「跳过区间」。**行集清空而不是返回部分数据** —— 不许把残缺结果当完整结果用。

要重建整个库则走 `recoverDatabase`：坏页扫描 → 解密 → SQLite recover →
重新加密 → 补 QQ 头 → 自检，源库只读。

## 七、相关

- [nt_helper.node 接口文档](/develop/nt-helper-interface) — 全部函数签名与返回类型
- [gpro 频道库密钥](gpro-database.md) — 算法组合不一致的实例
- [商城表情的解密](mface-decrypt.md) — 另一套独立的加密体系
- [数据库一览](/database/) — 各库的表结构

---

[← 返回原理总览](index.md)
