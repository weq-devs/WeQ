# nt_helper.node 接口文档

> `nt_helper.node` 是一个用 Rust（napi-rs）编译的原生 N-API 模块，已经把「QQ 进程检测、数据库解密 / 直查 / 导出、ptlogin2 cookie、注入 hook、在线协议发包、商城表情 / 字体 / 装扮资源」这些重活全部封装好了。Node 侧（主进程、`@weq/db`、`@weq/protocol`、各种 worker）**直接加载调用即可**，不要重新实现里面的任何一个能力。
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

所有功能函数在真正干活前都会内部调用 `logger::init_logger()` 与**环境校验**（有效期检查）。务必按下面的顺序初始化：

1. **先 `setLogPath`**（可选但建议）：配置日志路径，否则日志落到默认位置。
2. **再 `getInitStatus()`**：返回初始化状态；
   - `0` = 可用，继续；
   - 非 `0` = 环境校验失败（构建过期 / 损坏 / 源码改动被检测到），此时多数接口会**直接抛错**（`"Environment validation failed"`）或返回一个默认的“失败”值，详见 §2.
3. `getInitStatus()` 可以且**应该**在每次加载 `require` 之后调用一次，作为对「模块是否可用」的硬性检查（如 `inject_worker.ts` 的做法）。

> **dev 构建无时间戳 → 跳过校验**：本地 `cargo/npm build` 出的 `.node` 不带 `BUILD_TIMESTAMP`，`getInitStatus()` 直接返回 `0`，没有任何有效期 / LICENSE 限制；带时间戳的 CI release 构建才会走 30 天有效期检查。

---

## 2. 环境与工具函数

| JS 函数 | 参数 | 返回 | 说明 |
| ---- | ---- | ---- | ---- |
| `getInitStatus()` | — | `number` | 全局初始化状态：`0`=可用，`-1`=过期，`-200`=损坏，`-201`=被篡改，`99`=未知。 |
| `setLogPath(path)` | `path: string` | `Promise<void>` | 配置日志输出路径；内部 `logger::set_log_path`。 |
| `computeBkn(skey)` | `skey: string` | `number` | 由 `skey` / `p_skey` 计算 `bkn`（CSRF token）。纯函数，无需 QQ 在线。 |
| `resolveAppidFromMajor(majorPath)` | `majorPath: string` | `Promise<AppidInfo>` | 从 QQ NT 的 `resources/app/major.node` 直接扫描出 `appid` / `qua` / `version` / `build`，所见即所得，无静态版本表。 |
| `convertFont(inputPath, outputPath)` | 俩字符串路径 | `Promise<string>` | FTF → 标准 TTF 转换；本来就是 TTF 则直接拷贝。返回说明消息。 |
| `getMarketFaceKey(packetId)` | `packetId: string` | `Promise<MarketFaceKey \| null>` | 恢复商城表情包 QQTEA 密钥（自包含：抓 android.json 提示 → xydata 快路径 → 采样爆破）。返回 `null` 表示拿不到。 |
| `queryDressResourceUrl(dtype, itemId, name)` | 三个字符串 | `DressResourceUrl \| null` | 纯本地查装扮资源下载 URL（font/bubble/widget × 部件名），不联网、不依赖协议。`null` = 本地包缺失或未命中（此时交给协议兜底）。 |

**携带数据的封箱类型**

- `AppidInfo = { appid: string; qua?: string; version?: string; build?: string }`
- `MarketFaceKey = { timestamp: number; key: string; source: 'xydata' | 'brute-force' }`
- `DressResourceUrl = { url: string; size: number }`

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
| `requestDecryptKey(pid, dbPath)` | `pid`, `dbPath` | `Promise<string>` | 向**已注入 hook** 的 QQ 进程要密钥（OIDB 0xcde_2），返回十六进制密钥。注：此接口需先注入（§6）。 |
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

---

## 6. 注入 hook 与在线协议发包

「要密钥 / 拿在线数据（图片 rkey、cookie、skey 等）」前提是把 hook 注入进在线 QQ 进程。**Windows / Linux 用注入，macOS 因 SIP 走 `ninebird` 加载器**（见 `docs/principles/ninebird-macos.md`）。整套 hook 管道的 IPC 由 native 侧维护（unix socket / named pipe），JS 侧不用关心。

### 6.1 注入与就绪

| JS 函数 | 参数 | 返回 | 说明 |
| ---- | ---- | ---- | ---- |
| `injectAndGetStatus(pid, dllPath, uin)` | pid + hook 库绝对路径 + uin（≥8 位数字） | `Promise<QQInstanceStatus>` | 注入 `qq_hook.dll` / `libqqhook.so` 并返回实例状态。注入前**必须知道该 pid 的 uin**（native 不再自推导）。Linux 下注入后等待 hook 绑定 MSFService。 |
| `injectAndGetStatusEmbedded(pid, uin)` | pid + uin | `Promise<QQInstanceStatus>` | 便捷版：自动解出内置 hook 库到临时目录，无需传 `dllPath`。**日常推荐用它**。 |
| `waitForRealPacket(pid, timeoutMs)` | pid + 超时毫秒 | `Promise<HookRecvPacketInfo>` | 等 hook 观察到一条真正的登录后收包（忽略登录快照与预登录指令），用于判定注入链路真正就绪。 |

- `QQInstanceStatus = { pid: number; loggedIn: boolean; uin: string }`
- `HookRecvPacketInfo = { sequence: string; error: number; cmd: string; uin: string; body: Buffer }`

> ✔️ Windows / Linux 注入需 **root / 特权**（ptrace / 远程线程），实践中抽到独立的 elevated worker 里做（如 `inject_worker.ts`），宿主无特权进程再走 hook socket 收怪。

### 6.2 在线协议（均需已注入的 `pid`）

| JS 函数 | 参数 | 返回 | 说明 |
| ---- | ---- | ---- | ---- |
| `fetchDownloadRkeys(pid)` | `pid` | `Promise<string>` | OIDB 0x9067_202 拿图片下载 `rkey`（私聊/群聊/兜底），**返回 JSON 字符串**。 |
| `fetchClientKey(pid)` | `pid` | `Promise<string>` | OIDB 0x102A_1 拿 `clientKey`（ptlogin2 cookie 认证），**返回 JSON 字符串**。 |
| `fetchSkey(pid, uin)` | pid + uin | `Promise<string>` | ptlogin2 jump 流程拿 `skey`。 |
| `fetchPskey(pid, uin, domain)` | + domain | `Promise<string>` | 拿指定业务域名的 `p_skey`（如 `qun.qq.com`）。 |
| `sendOidbPacket(pid, command, subCommand, body, isUid)` | + OIDB 命令/子命令/protobuf body/isUid | `Promise<Buffer>` | **通用 OIDB 发包**：任何 OIDB 请求都行，无需改 native。`isUid=true` 走 UIN-form 变体（reserved=1）。 |
| `sendPacket(pid, cmd, body)` | + 完整 SSO 命令串 + protobuf body | `Promise<Buffer>` | 通用原始发包，给**不是 OIDB 的 trpc 服务**用（命令串如 `QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList`）。 |

> 新增「走后门业务」优先考虑 `sendOidbPacket` / `sendPacket` 通用接口 + `packages/codec` 的 schema 解析，**不要为此改 native 引入新接口**。

---

## 7. 平台相关 / 其它

| JS 函数 | 参数 | 返回 | 说明 |
| ---- | ---- | ---- | ---- |
| `checkWindowsHelloAvailability()` | — | `Promise<{ code: number; available: boolean }>` | 查询 Windows Hello 可用性。非 Windows 恒返回 `NotSupported(100)`。 |
| `verifyWindowsHello(message, hwnd?)` | 提示文案 + 可选 `hwnd`（预留） | `Promise<{ code: number; success: boolean }>` | Windows Hello 弹窗验证。**实现细节勿改**：native 在专用 MTA 线程执行 WinRT 异步，避免 Electron STA 主线程死锁。 |

---

## 8. 常见坑 & 约定（给维护者）

1. **先 `getInitStatus()` 再干活**：环境校验失败时，`check_init!` 类函数会抛 `EnvIrreversiblyError` / `"Environment validation failed"`；`check_init_or_default!` 类则返回“失败默认值”（如 probe 返回 `success:false`）而非抛错。调用方两种都要处理。
2. **`setLogPath` 尽早调用**：每个接口内部都会 `logger::init_logger()`，日志目标取决于当时配置。
3. **连接缓存**：`executeSql*` 对同一 `dbPath` 缓存连接。登出 / 换号记得 `closeDb` / `closeAllDb` 释放句柄与密钥。
4. **SQL 只读优先**：`executeSql` 注释明确“SELECT only recommended”；写接口存在且可用，但改动 QQ 运行时数据库前务必先备份。
5. **`algo` 别假设**：QQ NT 各库、各客户端版本的 page/KDF HMAC 不固定。未知库一律先 `testDatabaseKey`，得到 `CipherAlgo` 再喂给其它函数；不要硬编码 `SHA1/SHA1`。
6. **在线接口需先注入**：§6.2 全家、`requestDecryptKey` 的前提都是「已注入的在线 QQ pid」。
7. **JSON vs 对象**：`fetchDownloadRkeys` / `fetchClientKey` 返回的是 **JSON 字符串**，要先 `JSON.parse`；其余基本返回普通对象 / 数组。
8. **不要重复造轮子**：上面列的每一项 native 都已实现并经过验证。给 WeQ 加功能前，先在本页 / `packages/db` / `packages/protocol` 里找现成能力

---

## 9. 相关链接

- 源码：`../nt_helper/src/`（Rust / napi-rs），入口 `lib.rs`
- 使用示例：`apps/desktop/src/main/inject_worker.ts`（加载 + 初始化 + 调用）
- 数据库层封装：`packages/db`（基于 `executeSqlWithKey` 等）
- macOS 注入说明：`[ninebird-macos.md](../principles/ninebird-macos.md)`

[← 返回开发者入口](./index.md)