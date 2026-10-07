# nt_helper.node 接口文档

> `nt_helper.node` 是一个用 Rust（napi-rs）编译的原生 N-API 模块，已经把「QQ 进程检测、数据库解密 / 直查 / 导出、ptlogin2 cookie、只读内存取会话物料、原生 SSO 发包、商城表情 / 字体 / 装扮资源」这些重活全部封装好了。Node 侧（主进程、`@weq/db`、`@weq/protocol`、各种 worker）**直接加载调用即可**，不要重新实现里面的任何一个能力。
>
> 下面每个接口往下翻——如果在写代码时发现某件事「看起来很底层」，大概率这里已经提供了现成函数。先搜文档，再决定要不要动手。

---

## 1. 模块总览

- **加载方式**：纯 Node 原生模块（N-API），`require()` / `createRequire()` 直接加载，无需 rebuild、无需 Electron 主线程。
- **文件名来源**：Cargo `[lib] name = "nt_helper"`，`crate-type = ["cdylib"]`，产物以 `nt_helper.node` 落在 `native/<platform>/<arch>/` 下。
- **命名约定**：导出函数一律为 **camelCase**（NAPI 自动由 Rust 的 snake_case 转换），下文的接口名均为直接可用的 JS 名称。返回的对象字段同理（`page_hmac_algorithm` → `pageHmacAlgorithm`）。
- **异步**：`async` 原生函数在 Node 侧返回 **Promise**；内部用 `spawn_blocking` 把耗时工作丢到阻塞线程池，不阻塞 JS 事件循环。
- **跨平台**：同一套 JS 接口，Windows / Linux / macOS 全部可用；个别接口输入与行为按平台有差异，下面逐个标注。

### 1.1 加载与初始化（必须先做）

```ts
import { createRequire } from 'node:module';
const requireFn = createRequire(__filename);
const nt = requireFn('native/linux/x64/nt_helper.node');
```

> 仓库里**不带** `native/**/nt_helper.node`（历史太大，已拆到
> [nt_helper_release](https://github.com/H3CoF6/nt_helper_release) 分发）。
> dev 克隆先跑 `pnpm native:fetch` 取最新构建，细节见
> [原生二进制与装扮资源的分发](./native-artifacts.md)。

所有功能函数在真正干活前都会内部调用 `logger::init_logger()` 与**环境校验**（有效期检查）。务必按下面的顺序初始化：

1. **先 `setLogPath`**（可选但建议）：配置日志路径，否则日志落到默认位置。
2. **再 `getInitStatus()`**：返回初始化状态；
   - `0` = 可用，继续；
   - 非 `0` = 环境校验失败（构建过期 / 损坏 / 源码改动被检测到），此时多数接口会**直接抛错**（`"Environment validation failed"`）或返回一个默认的“失败”值，详见 §2.
3. `getInitStatus()` 可以且**应该**在每次加载 `require` 之后调用一次，作为对「模块是否可用」的硬性检查（如 `attach_worker.ts` 的做法）。

> **dev 构建无时间戳 → 跳过校验**：本地 `cargo/npm build` 出的 `.node` 不带 `BUILD_TIMESTAMP`，`getInitStatus()` 直接返回 `0`，没有任何有效期 / LICENSE 限制；带时间戳的 CI release 构建才会走 30 天有效期检查。

---

## 2. 环境与工具函数

| JS 函数 | 参数 | 返回 | 说明 |
| ---- | ---- | ---- | ---- |
| `getInitStatus()` | — | `number` | 全局初始化状态：`0`=可用，`-1`=过期，`-200`=损坏，`-201`=被篡改，`99`=未知。 |
| `setLogPath(path)` | `path: string` | `Promise<void>` | 配置日志输出路径；内部 `logger::set_log_path`。 |
| `resolveAppidFromMajor(majorPath)` | `majorPath: string` | `Promise<AppidInfo>` | 从 QQ NT 的 `resources/app/major.node` 直接扫描出 `appid` / `qua` / `version` / `build`，所见即所得，无静态版本表。 |
| `convertFont(inputPath, outputPath, options?)` | 俩字符串路径 + 可选 `ConvertFontOptions` | `Promise<string>` | FTF → 标准 TTF 转换；本来就是 TTF 则直接拷贝。默认还会把 `brsh`/`cglf` 编译成彩色字体（`COLR` v1 + `CPAL` v0）、把 `eimg` 炫彩帧导到 `<输出名>_assets/`（`frame_<槽位>.png`）、并用本机 `ots-sanitize` 预检产物。返回说明消息，如 `converted FTF to TTF; exported 109 eimg frame(s) (350x141) to …; OTS ok`。 |
| `getMarketFaceKey(packetId)` | `packetId: string` | `Promise<MarketFaceKey \| null>` | 恢复商城表情包 QQTEA 密钥（自包含：抓 android.json 提示 → xydata 快路径 → 采样爆破）。返回 `null` 表示拿不到。 |
| `queryDressResourceUrl(dtype, itemId, name)` | 三个字符串 | `DressResourceUrl \| null` | 纯本地查装扮资源下载 URL（font/bubble/widget × 部件名），不联网、不依赖协议。`null` = 本地包缺失或未命中（此时交给协议兜底）。 |

**携带数据的封箱类型**

- `AppidInfo = { appid: string; qua?: string; version?: string; build?: string }`
- `MarketFaceKey = { timestamp: number; key: string; source: 'xydata' | 'brute-force' }`
- `DressResourceUrl = { url: string; size: number }`
- `ConvertFontOptions = { color?: boolean; colorChars?: string; assetsDir?: string; checkOts?: boolean }`（缺省即全开；`assetsDir: ''` 关图包，`color: false` 关彩色，`checkOts: false` 关校验）。早于该开关的 nt_helper 会忽略第三个参数（只做转换），调用方不必探测版本。

---

## 3. QQ 进程 / 登录状态检测

这些是**纯只读探测**，不注入、不改库。注意：大部分 probe 函数失败时**不抛错**，而是返回带 `success` / `msg` 字段的“失败”对象（不满足某先决条件时会返回与真实失败相同形状的默认值），调用方按字段判断即可。

| JS 函数 | 参数 | 返回 | 说明 |
| ---- | ---- | ---- | ---- |
| `getQqProcesses(headless?)` | `headless?: boolean` | `Promise<number[]>` | 全部 QQ 主进程 PID。macOS 按 `headless` 二选一：默认走 bundle id 直查（需 GUI），`true` 走 `libproc` 全量枚举。 |
| `probeQqLoginInfo(pid)` | `pid: number` | `Promise<QqPortLoginInfo \| null>` | 通过本地端口探测登录态 / UIN / 昵称。`null` = 没拿到信息。 |
| `probePtLoginPort(pid)` | `pid: number` | `PtLoginPortProbeResult` | 探测 pt_login 端口（奇数 HTTPS / 偶数 HTTP，优先 HTTPS）。 |
| `probeDbLock(dbPath)` | `dbPath: string` | `DbLockProbeResult` | 反查哪些进程占用了数据库文件（`success`+`locked`+`holders`）。Windows 用 Restart Manager，Unix 用 fcntl 写锁探测。只读。 |
| `isQqLoggedIn(uin, baseDir?, uid?)` | `uin`, `baseDir?`, `uid?` | `boolean` | 某账号是否登录中。**平台差异**：Windows 用 `uin` 查命名互斥体；Linux/macOS 用 `baseDir` + `uid` 探测 `nt_msg.db` 的 fcntl 锁（缺任一 `false`）。 |

**返回类型**

- `QqPortLoginInfo = { port: number; uin: string; uid?: string; nickName?: string; loggedIn: boolean }`
- `PtLoginPortProbeResult = { success: boolean; msg: string; port: number }`
- `DbLockProbeResult = { success: boolean; msg: string; locked: boolean; holders: DbLockHolder[] }`
- `DbLockHolder = { pid: number; name: string }`

---

## 4. 数据库密钥获取与校验

获取 QQ NT 加密库的解密密钥，三条路线都在这里，**优先复用，别自己重写内存扫描**。

| JS 函数 | 参数 | 返回 | 说明 |
| ---- | ---- | ---- | ---- |
| `scanKeyFromDatabase(dbPath, pid)` | `dbPath: string`, `pid: number` | `Promise<KeyScanResult>` | **零注入**内存扫描拿 raw master key，用 `dbPath` 过滤候选。扫描逻辑移植自 x_key_scanner，候选并行校验。 |
| `testDatabaseKey(dbPath, key)` | `dbPath`, `key` | `Promise<KeyTestResult>` | 试 `key` 是否能解开库，**穷举 page-HMAC × KDF-HMAC 全部 12 种组合**，返回能解开的那组算法。用于不知道 `algo` 时先探测一次。 |
| `decryptLoginDb(loginDbPath, algo)` | 路径 + `CipherAlgo` | `Promise<LoginAccount[]>` | 走 offset VFS 解密 `login.db` 拿缓存登录账号，不落临时明文文件。`algo` 可先用 `testDatabaseKey` 探测。 |
| `getGuildDbKey(dbPath, uin)` | 路径 + `uin` | `Promise<string>` | 计算 QQ 频道（gpro）库的密钥：扫描库内 salt + 特定 md5 公式。 |

**返回类型**

- `KeyScanResult = { success: boolean; key?: string; keyContextHex?: string; error?: string }`
  - `key`：恢复出的 16 字节 raw master key；`keyContextHex`：密钥前后各 256 字节内存窗口的 hex（定位佐证）。
- `KeyTestResult = { success: boolean; pageHmacAlgorithm?: string; kdfHmacAlgorithm?: string }`
  - 成功时 `pageHmacAlgorithm` ∈ `'none' | 'SHA1' | 'SHA256' | 'SHA512'`，`kdfHmacAlgorithm` ∈ `'SHA1' | 'SHA256' | 'SHA512'`。
- `LoginAccount = { uin: string; uid: string; avatarUrl: string; userName: string; a1Key: string; lastLoginAt: number }`

---

## 5. 加密库直查 / 解密 / 导出（`@weq/db` 的基础）

对 QQ NT 加密库（SQLCipher v4 + 1024 字节 wrapper 头）的读写与导出。全部走自定义 **offset VFS** 透明跳过文件头，**连接默认缓存** —— 同一 `dbPath` 首次打开解密一次，后续调用复用句柄，极大省开销。`better-sqlite3` 在 running code 里零引用，读库统一走这里。

| JS 函数 | 参数 | 返回 | 说明 |
| ---- | ---- | ---- | ---- |
| `executeSql(dbPath, sql, params?)` | 路径 + SQL + 可选参数 | `Promise<SqlValue[][]>` | 只读查询（offset VFS，无密钥）。注意：这只适用于无需 SQLCipher 密钥的库；带密钥的库首次需要用 `executeSqlWithKey` 领证，之后才能用 `executeSql` 复用。 |
| `executeSqlWithKey(dbPath, sql, key, algo, params?)` | + `key` + `CipherAlgo` | `Promise<SqlValue[][]>` | 带密钥查询。**密钥只消费一次**：首个调用驱动 PRAGMA cipher 舞步并缓存连接，之后可省略密钥用 `executeSql`。 |
| `executeSqlWrite(dbPath, sql, params?)` | 同上（写） | `Promise<number>` | 写操作，返回受影响行数。带空闲检测 + BEGIN IMMEDIATE 重试。**谨慎使用**：写前注意备份。 |
| `executeSqlWriteWithKey(...)` | + `key` + `algo` | `Promise<number>` | 带密钥的写操作。 |
| `closeDb(dbPath)` | 路径 | `number` | 关闭该路径所有缓存连接，返回关闭数。登出 / 释放文件句柄时调用。 |
| `closeAllDb()` | — | `number` | 关闭全部缓存连接。 |
| `fastDecryptDatabase(dbPath, outPath, key, algo)` | 路径们 + key + algo | `Promise<void>` | 快速解密到标准 SQLite（直接落盘）。 |
| `safeDecryptDatabase(dbPath, outPath, key, algo)` | 同上 | `Promise<void>` | 安全解密：所有读走 SQLite（offset VFS + `sqlcipher_export`），长导出期间不怕 QQ checkpoint 撕页；无中间文件。 |
| `checkDatabaseHealth(dbPath, key, algo)` | 路径 + key + algo | `Promise<DatabaseHealthResult>` | `PRAGMA integrity_check` 体检；整体失败时逐表出结果。 |
| `executeSqlSalvage(dbPath, sql, params?, level?)` | 路径 + SQL + 可选参数 + 宽容级别 | `Promise<SalvageQueryOutcome>` | 宽容只读查询（独立的 salvage 连接）。**不因“损坏”抛异常**，而是返回 `ok:false` + 错误码，由调用方决定放弃还是切更小的一段；其它错误照旧抛。级别 ≥ 1 时遇到损坏会换访问路径（`NOT INDEXED`）重试。 |
| `executeSqlSalvageWithKey(dbPath, sql, key, algo, params?, level?)` | 同上 + key + algo | 同上 | 带密钥版本，语义相同。 |
| `executeSqlSalvageScan(dbPath, sql, params, options, level?)` | + `SalvageScanOptions` | `Promise<SalvageScanOutcome>` | 分块容错扫描（L2/L3）：读不出来的块先换访问路径、再二分到 `minSpan`，仍坏就记成“跳过区间”；`ok:false`（超预算 / 未授权 L2 / 表被隔离）时行集被清空，不许把部分数据当完整数据用。 |
| `executeSqlSalvageScanWithKey(...)` | 同上 + key + algo | 同上 | 带密钥版本。 |
| `closeSalvageDb(dbPath)` | 路径 | `number` | **只**释放该库的 salvage 只读连接（严格连接一律不动），并清掉该库的 L3 隔离记录。用户把宽容级别调回严格时用它。 |
| `scanBadPages(dbPath, key, algo)` | 路径 + key + algo | `Promise<BadPageScanResult>` | 逐页复算页 HMAC，产出物理坏页清单（“坏页地图”）。⚠ `usedHmac=false` 时 `badPages` 必为空 —— 那不是“库是好的”，而是“这个库没开页 HMAC（或压根是明文库，见 `plaintext`），地图没有意义”。只读密文。 |
| `listQuarantinedTables()` | — | `QuarantinedTable[]` | 当前被 L3（整表放弃）隔离的表。**进程内**状态，条目默认 300 秒自动失效（到点自动再试）。 |
| `clearQuarantinedTables(dbPath?, table?)` | 可选两级过滤 | `number` | 清掉隔离记录让那些表立刻再试。只给 `dbPath` → 清该库；再加 `table` → 只清那一张；都不给 → 全清。 |

调用解密接口前使用 `@weq/native` 的 `selectDatabaseDecryptMethod(dbPath, mode)`：
它保留用户指定的安全模式，并把 ≥ 512 MiB 的快速解密请求切换到安全模式。
搜索索引重建和数据库导出共用该选择逻辑，避免快速接口整库分配内存导致 Electron
进程崩溃（worker 线程也不能隔离原生内存分配失败）。

### 5.1 参数类型 `CipherAlgo`

几乎所有带密钥操作都要传 `algo`（page-HMAC × KDF-HMAC 组合）。**先用 `testDatabaseKey` 探测未知库**得到这对算法，再喂给本节的各函数：

```js
{ pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA1' }
// page: 'none' | 'SHA1' | 'SHA256' | 'SHA512'
// kdf : 'SHA1' | 'SHA256' | 'SHA512'
```

字符串大小写不敏感。

### 5.2 SQL 参数与返回值 `SqlValue`

`params` 支持 `null | bigint | number | string | Buffer | Uint8Array`；返回行内每个单元格为：

- NULL → `null`
- INTEGER → `bigint`（保留完整 i64 精度，QQ 的 µs/ns 时间戳不会溢出）
- REAL → `number`
- TEXT → `string`
- BLOB → `Buffer`

```
executeSqlWithKey 返回行示例：
[
  [1n, "文本", Buffer.from([...]), 123n],
  ...
]
```

### 5.3 返回类型

`KeyTestResult` / `DatabaseHealthResult = { healthy: boolean; corruptedTables: string[] }`。

### 5.4 损坏宽容（salvage）等级与契约

上面四个 `*Salvage*` 接口是同一套降级机制的四档。**级别永远由调用方（用户设置）给定，
native 不自己猜**；级别 0 时读取与今天逐字节相同。

| 级别 | 含义 | 会丢数据吗 | 生效范围 |
| ---- | ---- | ---------- | -------- |
| 0 | 严格：任何错误原样报出 | —（默认） | 默认路径 |
| 1 | 换访问路径（`NOT INDEXED`），只改 SQLite 的访问方式 | **不会** | 走宽容入口的读查询 |
| 2 | 跳过坏页覆盖的行区间（分块扫描） | 会 | **只有**满足下面第 1 条契约的查询（WeQ 接在导出链路上） |
| 3 | 整表放弃：隔离读不动的表，保证其它表可用 | 会 | 在级别 2 的基础上启用，`(db_path, table)` 粒度 |

#### 5.4.1 能救什么、救不了什么（2026-09-20 真实损坏库实测）

阈值与代价都是量出来的，不是估的；写在这里以免界面或文档再一次把能力写宽：

* **聚合查询救不了，级别再高也一样**。SQLite 没有“跳过坏页继续执行”的开关 —— 任何语句
  一旦碰到坏页就整条以 `SQLITE_CORRUPT` 中止。实测同一条 `GROUP BY` 聚合在级别 0 / 1 / 2 / 3
  下都是 `kind=corrupt, code=11, 0 行`（约 120–230 ms）。年度报告、群分析这类整表聚合因此
  **完全不受宽容级别影响**，只有修复数据库才能恢复。
* **级别 1 只在“坏在索引上”时有救**。它的做法是把语句改写成 `NOT INDEXED` 重试一次；
  若坏的是**数据页本身**，换哪条路都要读那一页 —— 实测坏页同时在索引路径与全表路径上时，
  重试 121 ms 后仍然失败。
* **级别 2 的代价按“坏键”线性增长**：二分地板是 `span = 1`，一个读不出来的键约 **215 ms**
  （两次 native 尝试，~110 ms/次）。所以一个 4096 宽的导出窗口若横跨很宽的坏区间，第一块
  就要十几分钟才走得完；`maxSkippedSpan` 决定的是“要假死多久才肯放弃”。WeQ 的驱动层因此
  **故意收紧到 20 / 500**（native 那份 256 / 8192 的默认值留给明确要求长扫的场景），
  约 108 秒就会干净地按严格语义失败。
* **级别 2 的“跳过”是键轴上的，不是行上的**：`GROUP BY` / JOIN 这类没有整数键轴的查询
  无法切块，契约对不上时是**报错**，不会给出一份“看着完整、其实位置不明”的结果。
* **级别 3 的隔离粒度是整张表**：`(db_path, table)` 连续失败 3 次（`DEFAULT_MAX_FAILURES`）
  即隔离，存活 300 s（`DEFAULT_TTL_SECS`）。隔离期内这张表**所有**读都会短路返回
  `quarantined` —— 包括本来健康的会话，所以界面必须说清这一点。

几条必须遵守的契约：

1. **分块扫描的 SQL 契约**（native 不解析 SQL）：末两个 `?` 是区间边界 `(lo, hi]`、结果按
   key 升序、**第一列必须是整数 key**（一般是 `rowid`）。`seekSql`（已知键探针）的过滤条件
   必须与扫描语句一字不差，否则会按契约违规报错。
2. **只有损坏进宽容路径**：按 native 返回的**错误码**判定（11 = CORRUPT / 26 = NOTADB），
   不看错误文案；开库失败、`BUSY`、权限、语法错一律照旧抛。
3. **`skipped` / `skippedSpan` 不是行数**：区间内部有多少行读不出来就无从得知，而键跨度
   也不是行数上界（同一个键可能对应多行 —— 共享 `seq` 的灰条、贴表情）。报告里只能说
   “这一段读不出来”，不能说“最多丢 N 行”。
4. **预算是上界，不是许可**：`maxSkippedRanges` / `maxSkippedSpan` 用尽（native 默认 256 / 8192，
   相邻同类区间会先合并）就按严格语义**整体失败**，绝不“越救越多”。驱动层默认更紧（20 / 500，
   理由见 5.4.1）。 **跨度按区间几何（`hi - lo`）累计**，不照抄 native 单次返回的 `skippedSpan`：
   后者会把本次调用里已经知道的区间再算一遍；同一段坏区间被相邻窗口各报一次时，账本只记
   新增的那一截（实测 7 键的洞会被重复上报成 2 处 / 跨度 14）。
5. **`quarantined` 与损坏分开**：`ok=false && quarantined=true` 表示“这次根本**没查**”，
   `errorKind` 是 `"quarantined"`、`errorCode` 为 `null` —— 调用方的账本/报告必须与
   “替代路径也救不回来”分开计数。

---

## 6. 内存取会话物料与原生 SSO 发包

拿在线数据（图片 rkey、cookie、skey 等）的链路只有两步，都在 native 里：**① 只读 QQ 进程内存取出该会话的 a2 / d2 / d2key；② native 自己组帧、签名、直连 QQ 服务器收发**。发包**不再经过**「注入 hook + unix socket / named pipe 管道转发」那套（hook 传输层已删），也就没有「等 hook 就绪」这一环。NineBird 加载器仍在（`packages/ninebird`）—— 它负责拉起 QQ、做本地快速登录，不是发包通道；macOS 上 SIP 开着时读不了内存，就只走它。

> ⚠️ **登录取密钥也走这条链路**（三端一致）：`prepareInstanceAttach`（读内存拿 a2/d2/d2key + 登记原生 SSO 会话）→ `fetchKeyFromInstance`（发包 OIDB 0xcde_2 取 dbKey）。**登记是必备的一步** —— `sendOidbPacket` / `sendPacket` 只认已登记的 pid，`setSsoSession` 之前第一包必然报「还没有登记 SSO 会话」。登记用的 uid 从 `login.db` 解析、guid 从 QQ 数据根离线算（都无需额外权限）。
> 早期版本在 macOS 上另走一条「提权扫内存、直接用 `scanKeyFromDatabase` 拿 dbKey」的路（`macScanKeyFromMemory` / `mac_scan_worker`），现已被统一路径取代并删除 —— macOS 与其他两端走同一套「读内存 → 登记 → 发包」，只有 attach 要不要提权（以及 macOS 的 SIP 门槛）不同。

读内存这一步仍有权限门槛：Linux 要 root（或 `CAP_SYS_PTRACE`）且 `/proc/sys/kernel/yama/ptrace_scope` 放行；macOS 要 root **且**目标未开强化运行时保护（QQ 开了，所以得先关 SIP）；Windows 要管理员。macOS 上 SIP 开着时读内存无解（`task_for_pid` 连 root 都拒），此时登录流程直接改走 NineBird（扫码 / 快登，不读内存）。

> ℹ️ Linux 宿主**总是先试免密直连**：`yama ptrace_scope=0`（或 `CAP_SYS_PTRACE`）时同用户 attach 直接成功，不弹窗、不要密码；只有内核真的拒了（EPERM/EACCES）才回到提权。引导弹窗里的「不再提醒」**只静音该弹窗**，不影响这个顺序——被拒后仍会尝试提权。顺序钉在 `packages/service/src/bootstrap/attach_flow.ts`（有单测）。
>
> ⚠️ 例外：**root 读不到安装目录**的宿主（AppImage —— payload 在没开 `allow_other` 的 FUSE 挂载上；以及单用户 FUSE 家目录）跑不了 elevated worker，连 `exec` 我们自己的二进制都是 EACCES（`env: "…": 权限不够`）。这类宿主改为「root 只临时放开 yama ptrace 保护 → 非特权进程自己读 → 写回原值」，见 `apps/desktop/src/main/attach_elevation.ts` 的 `escalateViaPtraceScope`。

### 6.1 取物料

| JS 函数 | 参数 | 返回 | 说明 |
| ---- | ---- | ---- | ---- |
| `scanSessionMaterial(pid)` | pid | `Promise<SessionMaterial>` | 运行时 RTTI 自举、零硬编码 RVA，读出该会话的 a2 / d2 / d2key（十六进制串；没扫到的项为 `undefined`，不影响其它项）。失败时 reject，错误信息本身就是提权/版本变化的诊断提示。 |
| `readDeviceGuid(dataRoot)` | QQ 数据根路径 | `string \| null` | 离线算出设备 guid（32 位小写 hex）。**不需要任何权限、不碰进程**；算不出返回 `null`。 |
| `setSsoSession(pid, session, wrapperPath?)` | 物料 + `wrapper.node` 路径 | `Promise<void>` | 登记这一场会话。**只存不连**：不读内存、不发包时一个 socket 都不存在；TCP 等到第一次发包才建，闲置一分钟丢弃，断了下次发包自动重连。 |
| `hasSsoSession(pid)` / `clearSsoSession(pid)` | pid | `Promise<boolean>` | 诊断 / 忘掉物料（账号下线、QQ 重启时调用，会一并关掉可能存在的连接）。 |

- `SessionMaterial = { a2?: string; d2?: string; d2Key?: string }`
- `SsoSessionConfig = { uin; a2: Buffer; d2: Buffer; d2Key: Buffer; guid; uid; subAppId; clientConnSeq?; traceParent? }`（`traceParent` 只给离线比对用）

> ℹ️ **刻意不做上线注册与心跳**（对照 `../LagrangeV2`）：那是个纯协议框架，机器上只有它一个客户端，所以它必须自己发 `SsoInfoSync` 上线、自己心跳。我们不是 —— a2/d2/d2key 就是从同机 QQ 进程内存里读的，那条会话的在线状态与心跳由 QQ 本体维持；再注册一次只会让服务端看到「同设备 guid + 同一份 d2 的第二个客户端」。这里只借凭据发包，其余交给 QQ。

### 6.2 发包（`pid` 需先经 `setSsoSession` 登记）

| JS 函数 | 参数 | 返回 | 说明 |
| ---- | ---- | ---- | ---- |
| `sendOidbPacket(pid, command, subCommand, body, isUid, needSign?)` | OIDB 命令/子命令/protobuf body/isUid | `Promise<Buffer>` | **通用 OIDB 发包**：任何 OIDB 请求都行，无需改 native。`isUid=true` 走 UIN-form 变体（reserved=1）。`needSign`（缺省 true）由调用方按命令逐个标注。 |
| `sendPacket(pid, cmd, body, needSign?)` | 完整 SSO 命令串 + protobuf body | `Promise<Buffer>` | 通用原始发包，给**不是 OIDB 的 trpc 服务**用（命令串如 `QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList`）。`needSign` 同上。 |
| `resetPacketSequence()` / `currentPacketSequence()` | — | `number` | 全局发包序号。重连 / 换会话时先 `resetPacketSequence()` 回收起点；`currentPacketSequence()` 仅供诊断。 |
| `locateSignFunction(wrapperPath)` / `signPacket(wrapperPath, cmd, src, seq)` | `wrapper.node` 路径 + 命令 + 明文 + 序号 | RVA / `SignOutput` | `wrapper.node` 签名函数的定位与调用：`needSign` 的命令靠它算 `SecToken / SecExtra / SecSign`。离线逐字节核对抓包用 `buildSsoPacket(req)`。 |

> **业务命令不在 native**：clientKey / 下载 rkey / decryptKey / skey / p_skey / bkn 的请求构造
> 与解析已经在 `@weq/protocol` + `@weq/service`（`account/online_ticket.ts`）里实现，只通过
> 上面的两个通用接口发包。新增「走后门业务」继续走 `sendOidbPacket` / `sendPacket` + TS schema，
> **不要为此改 native 引入新接口**。

---

## 7. 网卡抓包（capture）

> 非侵入式、不注入：直接读网卡 → TCP 重组 → MSF 帧切分 → 用**调用方传入的 d2key**
> 做 TEA 解密（native 不再自己扫密钥）。

### 7.1 为什么是「会话 + 游标」而不是一次抓 N 秒

`pcap_open_live` + 装 BPF 过滤要几十到几百毫秒，而被抓的应答可能个位数毫秒就回来
（例如 QQ 语音转录：请求 → 立即 ack → 真正的结果稍后由服务端 push 推回）。先发包
再开抓，**首包必漏**。所以抓包是一条**可提前 armed 的长生命周期会话**：

```text
startCapture(pid)                       // 直到网卡已打开、BPF 已装、读循环即将开始才 resolve
  → 调用方发包（setSsoSession / sendOidbPacket / sendPacket …）
  → takeFrames(pid, { waitMs: 10_000 })  // 等到窗口结束，一次性取回全部帧，自己筛
  → stopCapture(pid)
```

取帧是**环形缓冲 + 游标**的拉模型：native 侧保证不漏，环形满了会如实把 `dropped`
报出来；`onFrame` 回调只是同一份数据的**可选**推送通道，JS 慢顶多丢投递，不影响
环形缓冲里的真相。会话按 `pid` 索引，与 `setSsoSession` 一致；多个 QQ 进程可各抓各的。

### 7.2 接口

| JS 函数 | 参数 | 返回 | 说明 |
| ---- | ---- | ---- | ---- |
| `probeCaptureSupport()` | — | `CaptureSupport` | 抓包后端是否就绪。Windows 检查 Npcap（`wpcap.dll`）；Linux/macOS 后端一定在，能否抓到取决于 `elevated`（权限）。`hint` 是缺后端/缺权限时的引导。 |
| `startCapture(pid, options?, onFrame?)` | pid + 可选 `CaptureOptions` + 可选回调 | `Promise<CaptureSession>` | 开启（或替换）抓包会话。**请在发包之前调用** —— 它直到网卡已打开、BPF 已装、读循环即将开始才 resolve。 |
| `takeFrames(pid, options?)` | pid + 可选 `TakeOptions` | `Promise<FrameBatch>` | 取帧。`waitMs > 0` 时一直收集到窗口结束再返回。 |
| `stopCapture(pid)` | pid | `Promise<CaptureStats>` | 停止并释放，返回统计。 |

**类型**

- `CaptureOptions = { d2key?; iface?; port?; ringFrames?; pcapFile? }`
  - `d2key`：32 字符 hex；省略时回退到该 pid 已登记的 `setSsoSession` 物料里的 d2key。
  - `iface`：默认 `auto`（自动选默认路由出口网卡），也可填 `eth0`/`en0`/Npcap 设备名。
  - `port`：默认 `auto`（持续按 MSF 帧签名识别，端口中途切换也不漏）；也可 `14000` / `14000,443,80` / `auto,443`。
  - `ringFrames`：环形缓冲帧数上限（默认 512）。
- `CaptureSession = { pid; iface; port; linktype }`
- `TakeOptions = { cursor?; waitMs?; minFrames?; maxFrames?; matchCmd? }`
- `CapturedFrame = { cursor; ts; direction; proto; encryptType; seq; cmd?; body?: Buffer; plain?: Buffer; raw: Buffer }`
  - `cmd` / `body` / `plain` 在 TEA 解密 + SSO 头解析成功后才有；`raw` 永远是完整原始帧（含 4 字节长度前缀）。
  - `body` 是**解密后的 protobuf 原始字节**，展开交给 `@weq/protocol` —— native 不引 protobuf 描述符。
- `FrameBatch = { frames; nextCursor; dropped }`：`dropped` 是**累计**溢出淘汰帧数；`nextCursor` 下次原样传回来即可续取。
- `CaptureStats = { frames; dropped; packets }`
- `CaptureSupport = { available; backend; elevated; hint }`

### 7.3 语音转录（异步结果）的用法

服务端的异步推送落在 `startCapture` 之后，所以「请求 → 监听 10 秒 → 自己筛」是安全的：

```ts
await nt.startCapture(pid, { d2key });        // 先 armed（早于发包）
try {
  await nt.sendPacket(pid, 'pttTrans.TransC2CPttReq', body);
  const batch = await nt.takeFrames(pid, { waitMs: 10_000 });  // 窗口内全部帧
  // batch.frames 里自己按 cmd / body 筛出 TransC2CPttRsp 与 OlPushService.MsgPush
} finally {
  await nt.stopCapture(pid);
}
```

### 7.4 权限与依赖

- **Linux**：需要 root 或 `CAP_NET_RAW`（与 attach 同档）；产物静态链接 libpcap，不依赖用户机的 `libpcap.so.*`。
- **macOS**：需要 root（BPF 设备默认 root 可读）。
- **Windows**：需要管理员 **且** 已安装 [Npcap](https://npcap.com/)；缺失时 `probeCaptureSupport()` 返回 `available: false` + 安装引导。

### 7.5 WeQ 侧怎么拿到这个权限（提权子进程）

Electron **不能以 root 运行**，而抓包要 root —— 所以桌面端把「抓包会话」整段放进一个
临时 root 子进程，主进程只做代理：

```text
渲染层点「开始抓包」
  → 主进程（wonderful_tools.captureStart）先登记 SSO 会话（读内存拿 d2key）
  → sudo -S 起 captureWorker.mjs（ELECTRON_RUN_AS_NODE，见 src/main/capture_elevation.ts）
  → 子进程 require nt_helper.node，拿到 {port, token} hello 后走环回套接字协议
  → 主进程把 start / take / stop 原样转给子进程（协议见 src/main/capture_protocol.ts）
```

要点：

- 密码来自**渲染层自绘的密码框**（`elev::request-password`，macOS 姿势的 `sudo -S`，不走 polkit）；
  起子进程前先 `sudo -n true` 探一次缓存，刚刚读过内存的机器不会再弹第二个框。
- 协议走 **127.0.0.1 环回套接字**而不是 stdin/stdout：`sudo -S` 要从 stdin 读密码，复用同一条
  管道会被 sudo 的缓冲读写吃掉。hello 里的随机 `token` 是门禁（端口只有本机可达）。
- 子进程是**另一个 native 实例**，主进程 `setSsoSession` 注册的物料它看不见，所以 `start`
  必须显式带 `d2key`；`setcap cap_net_raw,cap_net_admin+eip <binary>` 也能免掉提权，
  但不改系统是默认选择。
- 生命周期：主进程持着环回连接，断开（退出 / 崩溃）时子进程自己停会话再退出；退出时会
  主动 `dispose`。**不会**把 root 抓包留在后台。

---

## 8. 平台相关 / 其它

| JS 函数 | 参数 | 返回 | 说明 |
| ---- | ---- | ---- | ---- |
| `checkWindowsHelloAvailability()` | — | `Promise<{ code: number; available: boolean }>` | 查询 Windows Hello 可用性。非 Windows 恒返回 `NotSupported(100)`。 |
| `verifyWindowsHello(message, hwnd?)` | 提示文案 + 可选 `hwnd`（预留） | `Promise<{ code: number; success: boolean }>` | Windows Hello 弹窗验证。**实现细节勿改**：native 在专用 MTA 线程执行 WinRT 异步，避免 Electron STA 主线程死锁。 |

---

## 9. 常见坑 & 约定

1. **先 `getInitStatus()` 再干活**：环境校验失败时，`check_init!` 类函数会抛 `EnvIrreversiblyError` / `"Environment validation failed"`；`check_init_or_default!` 类则返回“失败默认值”（如 probe 返回 `success:false`）而非抛错。调用方两种都要处理。
2. **`setLogPath` 尽早调用**：每个接口内部都会 `logger::init_logger()`，日志目标取决于当时配置。默认只记 info 及以上事件；高频路径（`probeDbLock`、`closeDb`、`testDatabaseKey`、逐包接收、端口探测）都在 debug 级，排查时用环境变量 `WEQ_LOG_LEVEL=debug|trace` 抬升（`error` / `warn` / `off` 也可）。loader 侧的逐文件资产校验同理，用 `WEQ_NATIVE_DEBUG=1` 打开。
3. **连接缓存**：`executeSql*` 对同一 `dbPath` 缓存连接。登出 / 换号记得 `closeDb` / `closeAllDb` 释放句柄与密钥。
4. **SQL 只读优先**：`executeSql` 注释明确“SELECT only recommended”；写接口存在且可用，但改动 QQ 运行时数据库前务必先备份。
5. **`algo` 别假设**：QQ NT 各库、各客户端版本的 page/KDF HMAC 不固定。未知库一律先 `testDatabaseKey`，得到 `CipherAlgo` 再喂给其它函数；不要硬编码 `SHA1/SHA1`。
6. **在线发包需先登记物料**：`sendOidbPacket` / `sendPacket` 的前提是「该 pid 已 `setSsoSession` 登记过、且物料来自在线 QQ」。
7. **业务命令去 TS 找**：`clientKey` / rkey / decryptKey / skey / p_skey / bkn 见
   `packages/protocol` 与 `packages/service/src/account/online_ticket.ts`，不要在 native 层重复实现。
8. **不要重复造轮子**：上面列的每一项 native 能力都已实现并经过验证。给 WeQ 加功能前，先在本页 / `packages/db` / `packages/protocol` 里找现成能力

---

## 10. 相关链接

- 源码：`../nt_helper/src/`（Rust / napi-rs），入口 `lib.rs`
- 使用示例：`apps/desktop/src/main/attach_worker.ts`（加载 + 初始化 + 调用）
- 数据库层封装：`packages/db`（基于 `executeSqlWithKey` 等）
- NineBird 加载器（拉起 QQ / 本地快速登录）：`packages/ninebird`

[← 返回开发者入口](./index.md)
