/**
 * Public type surface of the `@weq/native` package.
 *
 * Mirrors `Qrypt-Native/nt_helper/src/lib.rs` (DB / detect / inject / OIDB)
 * and the `launchQQ` entry of `ninebird_addon.node` (login bootstrap).
 *
 * The actual .node files live under `<repo>/native/<platform>/<arch>/` and
 * are loaded by `loader.ts`. Nothing in this file does I/O — it's purely
 * type-level + a few runtime tag enums.
 */

// ---------- SQL value plumbing (mirrors database/value.rs) ---------------

/**
 * One cell value that crosses the napi boundary.
 *   INTEGER → bigint (i64 precision)
 *   REAL    → number
 *   TEXT    → string
 *   BLOB    → Uint8Array (Node Buffer also accepted on encode)
 *   NULL    → null
 */
export type SqlValue = null | bigint | number | string | Uint8Array;
export type SqlRow = SqlValue[];

// ---------- Init / health ------------------------------------------------

/** Mirrors `InitStatus` in lib.rs. */
export enum InitStatus {
  Success = 0,
  Expired = -1,
  Damaged = -200,
  Tampered = -201,
  UnknownError = 99,
}

// ---------- QQ process / login detection ---------------------------------

/**
 * Login account row decrypted from `login.db`. Mirrors `LoginAccount` in
 * `Qrypt-Native/nt_helper/src/detect/login_db.rs` (napi-rs converts the
 * Rust snake_case fields to camelCase).
 */
export interface LoginAccount {
  /** QQ number (account uin). */
  uin: string;
  /** Long uid used as a routing handle inside the protocol. */
  uid: string;
  /** Absolute URL of the cached avatar (CDN, may 404 if old). */
  avatarUrl: string;
  /** Display name set on the account. */
  userName: string;
  /** A1 cred token (empty if not cached). */
  a1Key: string;
  /** Unix seconds. 0 if never seen. */
  lastLoginAt: number;
}

/**
 * Port-probe result for one running QQ.exe. Mirrors `QqPortLoginInfo`
 * in `Qrypt-Native/nt_helper/src/detect/port.rs`.
 *
 * NOTE: this struct does NOT contain `pid` — the napi entry takes pid as
 * an input parameter and returns just the per-account info. Pair it
 * with the pid at the call site if you need both.
 */
export interface QqPortLoginInfo {
  /** Local port the info was scraped from (4301/4303/4305/4307/4309). */
  port: number;
  /** QQ number. Empty string when port responded but no uin attached. */
  uin: string;
  /** Long uid; null when the probe path didn't carry it. */
  uid: string | null;
  /** Display name; null when the probe path didn't carry it. */
  nickName: string | null;
  /** True if the port reports the account is currently logged in. */
  loggedIn: boolean;
}

/**
 * One process holding an account's database open / locked. Mirrors
 * `DbLockHolder` in `Qrypt-Native/nt_helper/src/detect/db_lock.rs`.
 */
export interface DbLockHolder {
  pid: number;
  /** Windows: Restart Manager `strAppName`; Linux: `/proc/<pid>/comm`. Empty when unavailable. */
  name: string;
}

/**
 * Outcome of `probeDbLock`. Mirrors `DbLockProbeResult` in
 * `Qrypt-Native/nt_helper/src/detect/db_lock.rs`.
 */
export interface DbLockProbeResult {
  /** Whether the probe itself ran. false = file missing / API failed — treat as "not locked / unknown". */
  success: boolean;
  msg: string;
  /** True when at least one process holds the file (i.e. `holders` is non-empty). */
  locked: boolean;
  holders: DbLockHolder[];
}

/**
 * pt_login 本地快速登录端口探测结果。Mirrors `PtLoginPortProbeResult` in
 * `Qrypt-Native/nt_helper/src/detect/port.rs`（napi-rs 自动把 snake_case 转 camelCase）。
 */
export interface PtLoginPortProbeResult {
  /** 探测是否成功（进程监听候选端口且 TCP 可达）。 */
  success: boolean;
  /** 成功 / 失败原因。 */
  msg: string;
  /** 可用端口：奇数 = HTTPS，偶数 = HTTP；失败时为 0。 */
  port: number;
}

/** `ptFetchSkey` 的返回：通过 ptlogin2 本地快速登录拿 skey（无需注入 hook）。 */
export interface PtFetchSkeyResult {
  success: boolean;
  msg: string;
  skey: string;
}

/** `ptFetchPskey` 的返回：通过 ptlogin2 本地快速登录拿指定域 p_skey（无需注入 hook）。 */
export interface PtFetchPskeyResult {
  success: boolean;
  msg: string;
  pskey: string;
}

export interface DatabaseAlgorithms {
  pageHmacAlgorithm: string;
  kdfHmacAlgorithm: string;
}

export interface DatabaseProbeResult {
  success: boolean;
  pageHmacAlgorithm?: string;
  kdfHmacAlgorithm?: string;
}

export interface DatabaseHealthResult {
  healthy: boolean;
  corruptedTables: string[];
}

/**
 * Outcome of a `scanKeyFromDatabase` run (zero-injection memory scan).
 * Mirrors `KeyScanResult` in `Qrypt-Native/nt_helper/src/key_scan/mod.rs`.
 */
export interface KeyScanResult {
  /** Whether the scan succeeded (a candidate verified against `db_path`). */
  success: boolean;
  /** The recovered 16-byte raw master key as a string, `None` on failure. */
  key?: string;
  /**
   * Lowercase hex of the memory context around the recovered key: the 256
   * bytes before it and the 256 bytes after it (clamped to the containing
   * memory region). Present only when `success` and the context read worked.
   */
  keyContextHex?: string;
  /** Failure reason when `success` is `false`, `None` on success. */
  error?: string;
}

/** Status returned after injecting the hook DLL into a QQ process. */
export interface QQInstanceStatus {
  pid: number;
  loggedIn: boolean;
  uin: string;
}

/**
 * A recv packet observed by the hook. Returned by `waitForRealPacket`. On
 * linux this is no longer required for readiness (the hook binds the MSF
 * service via the inject-time uin handshake) — it exists only as a debugging
 * probe now.
 */
export interface HookRecvPacketInfo {
  sequence: string;
  error: number;
  cmd: string;
  uin: string;
  body: Buffer;
}

export interface WindowsHelloAvailabilityInfo {
  code: number;
  available: boolean;
}

export interface WindowsHelloVerifyInfo {
  code: number;
  success: boolean;
}

/**
 * appid / QUA extracted from QQ NT's `major.node`. `appid` is always present;
 * `qua` / `version` / `build` are absent when the QUA anchor isn't found.
 */
export interface AppidInfo {
  appid: string;
  qua?: string;
  version?: string;
  build?: string;
}

// ---------- market-face key (商城表情 图片解密密钥) ----------------------

/**
 * The decryption key for a market-face (商城表情) image package, recovered by
 * `getMarketFaceKey`. Mirrors the result struct in `nt_helper`.
 *
 * The key is the 16-char ASCII prefix of `md5(str(seed))`, where `seed` is a
 * unix-seconds timestamp the CDN used when generating the encrypted GIF. The
 * native side finds it either directly (metadata carried the seed) or by
 * brute-forcing a time window around the package's `updateTime` (TEA-decrypt
 * the first two blocks, check for a `GIF8` header).
 */
export interface MarketFaceKeyResult {
  /** 16-char ASCII hex key fed to the XOR/TEA image decryptor. */
  key: string;
  /** Unix-seconds timestamp whose `md5` prefix produced `key`. */
  timestamp: number;
  /**
   * How the key was recovered:
   *   - `'xydata'`      the seed came straight from package metadata (免费包)
   *   - `'brute-force'` scanned a time window around `updateTime`
   *                     (TEA-decrypt → `GIF8` check) — needed for 付费包
   */
  source: string;
}

// ---------- database repair (recoverDatabase) ----------------------------

/**
 * `checkpointWal` 的产出（SQLite `PRAGMA wal_checkpoint` 三列 + 它的结论）。
 *
 * 调用方只该看 `merged`：前三个数字是 SQLite 原样报上来的，用来留痕/排障。
 */
export interface WalCheckpointResult {
  /** 1 = 这次被别的连接挡住了（还有读快照 / 读写事务），帧没能全部写回。 */
  busy: number;
  /** `-wal` 里的帧数。`-1` = 这个库不在 WAL 模式（压根没有 WAL）。 */
  log: number;
  /** 成功写回主文件的帧数。`-1` = WAL 已被重置。 */
  checkpointed: number;
  /** checkpoint 之后 `-wal` 的字节数（0 = 已截断，或本来就没有 WAL）。 */
  walBytes: number;
  /** 帧是否已经完整回到主文件里了。`false` = 那批改动依然只在 `-wal` 里。 */
  merged: boolean;
}

/**
 * 修复流水线的阶段（与 `nt_helper` 的 `RecoverPhase` 字符串枚举一致）。
 *
 * TS 侧另外会在 native 前后补 `'backup' | 'swapping' | 'done'` 三个自有阶段
 * （见 `@weq/service` 的 `DbRepairPhase`），所以消费这个类型时用宽松字符串更稳妥。
 */
export type RecoverPhase = 'Scan' | 'Decrypt' | 'Repair' | 'Encrypt' | 'Restore' | 'Verify';

/** `recoverDatabase` 的入参。 */
export interface RecoverOptions {
  /** 加密的 QQ 库路径（含 1024 字节自定义头）。**本函数不会修改它**。 */
  dbPath: string;
  /** 修复产物路径：加密库 + 已补回自定义头，可直接被 QQ / WeQ 打开。 */
  outPath: string;
  /** 明文中间件目录。会被创建；中间件在函数返回前删除。 */
  workDir: string;
  key: string;
  algo: DatabaseAlgorithms;
  /**
   * 严格页模式（默认 `false`）。
   *
   * `false`：坏页上"未通过 HMAC 的明文内容"照样写进新库 —— 恢复率最高，
   * 但那些字节可能已被 CBC 糊掉。
   * `true`：先把坏页清零再重建 —— 结构一定合法、不引入未校验内容，代价是那些行明确丢失。
   */
  strictPages?: boolean;
  /** 是否也从 freelist 上捞已删除的记录（默认 `false`，打开会"复活"已删除消息）。 */
  recoverFreelist?: boolean;
  /** 孤立页回收表名，默认 `lost_and_found`；空字符串表示不做孤立页回收。 */
  lostAndFoundName?: string;
  /** 先建索引再灌数据（默认 `false`）：进度更连续但整体更慢。 */
  slowIndexes?: boolean;
}

/** 一次进度回调（napi 的 TSFN 约定：第一个参数是投递失败的错误）。 */
export interface RecoverProgress {
  phase: RecoverPhase;
  /** 整体百分比（0–100，单调不回退；阶段内为估算值）。 */
  percent: number;
  /** 给用户看的短句，例如"正在恢复 group_msg_table（第 1024/22454 页）"。 */
  message: string;
}

/** 单个阶段的耗时。 */
export interface RecoverPhaseTiming {
  phase: RecoverPhase;
  ms: number;
}

/** 产物自检结果。 */
export interface RecoverVerification {
  /** `PRAGMA integrity_check`（经 offset VFS + 密钥）是否通过。 */
  healthy: boolean;
  /** 自检判定有问题的表（正常为空）。 */
  corruptedTables: string[];
  /** 产物里仍然页 HMAC 校验失败的页（正常为空）。 */
  badPages: number[];
  tables: number;
  indexes: number;
  ms: number;
}

/** 修复结果报告。 */
export interface RecoverReport {
  dbPath: string;
  outPath: string;
  durationMs: number;
  sourceBytes: number;
  /** 产物大小（字节，含自定义头）。 */
  outputBytes: number;
  /** 源库的自定义头长度（0 或 1024）。 */
  headerOffset: number;
  pageSize: number;
  sourcePages: number;
  outputPages: number;
  /** 源库**物理坏页**清单（页 HMAC 失败）—— 即"内容不可信"的那几页。 */
  badPages: number[];
  /** 源库全零页清单。 */
  zeroPages: number[];
  strictPages: boolean;
  /** 重建过程中扫过的 cell 数量（**不是行数**）。 */
  scannedCells: number;
  phases: RecoverPhaseTiming[];
  verification: RecoverVerification;
}

// ---------- nt_helper.node — full surface --------------------------------

/**
 * Every function exported by `nt_helper.node` (see lib.rs).
 *
 * Methods that lib.rs marks `async` (return `napi::Result<…>` from an async
 * fn) are Promise-returning here. Sync-on-Rust-side methods return raw
 * values. Method names use camelCase because napi-rs auto-converts.
 */
/** One hit from the local dress bundle: full CDN URL + server-reported size. */
export interface DressResourceUrl {
  url: string;
  size: number;
}

/** `convertFont` 的可选开关（缺省即产品默认值：全开）。 */
export interface ConvertFontOptions {
  /** 生成彩色字体（`brsh`/`cglf` → `COLR` v1 + `CPAL` v0）。默认 `true`。 */
  color?: boolean;
  /** 额外强制上色的字符。QQ 皮肤端的逐字清单不在字体文件里，需要的话由调用方传入。 */
  colorChars?: string;
  /**
   * `eimg` 炫彩帧图片的导出目录。默认 `<输出文件同目录>/<输出名>_assets/`；
   * 传空串则「不导出」。
   */
  assetsDir?: string;
  /** 转换完成后用本机的 `ots-sanitize` 校验产物。默认 `true`（本机没装时自动跳过）。 */
  checkOts?: boolean;
}

export interface NtHelperBinding {
  // --- init / health ---
  getInitStatus(): InitStatus;
  setLogPath(path: string): void;

  // --- QQ process / login detection ---
  probeQqLoginInfo(pid: number): QqPortLoginInfo | null;
  /**
   * 探测 QQ 进程 pt_login 本地快速登录端口（4301-4310，奇数 = HTTPS、偶数 = HTTP，优先 HTTPS）。
   * 无需注入 hook，只要该账号的 QQ 客户端在线即可用。结果在 success / msg / port 字段。
   */
  probePtLoginPort(pid: number): PtLoginPortProbeResult;
  /**
   * 通过 ptlogin2 本地快速登录（qun.qq.com 配置）获取 skey，无需注入 hook。
   * 失败时 success=false 且 msg 带原因，不抛异常。
   */
  ptFetchSkey(port: number, uin: string): Promise<PtFetchSkeyResult>;
  /**
   * 通过 ptlogin2 本地快速登录获取指定域 p_skey，无需注入 hook。
   * 仅支持已验证的四域：qun.qq.com / qzone.qq.com / pd.qq.com / vip.qq.com。
   */
  ptFetchPskey(port: number, uin: string, domain: string): Promise<PtFetchPskeyResult>;
  /**
   * Probe which processes hold an account's `nt_msg.db` open / locked — the
   * cross-platform way to attribute a running QQ to an account AND recover its
   * pid in one step. Windows enumerates Restart Manager open-handle holders
   * (may include non-QQ processes like WeQ itself — filter by name); Linux
   * reports the fcntl write-lock holder's pid via `F_GETLK`. The holder list
   * is not filtered here: callers decide which holder is QQ.
   */
  probeDbLock(dbPath: string): DbLockProbeResult;
  decryptLoginDb(loginDbPath: string, algo: DatabaseAlgorithms): LoginAccount[];
  /**
   * Get all QQ main process IDs.
   *
   * macOS picks the enumeration mechanism via `headless` (no auto-fallback):
   *   - `false` (default): `NSRunningApplication` by bundle id
   *     `com.tencent.qq` — precise, needs a GUI session;
   *   - `true`: `libproc` full enumeration filtered by the
   *     `/QQ.app/Contents/MacOS/QQ` executable path — works headless.
   * Ignored on win32/linux (the arg exists only because the native signature
   * is shared).
   */
  getQqProcesses(headless?: boolean): number[];
  /**
   * Is the QQ account currently logged in on this machine? The identifying
   * inputs differ per platform because the mechanism does:
   *   - **win32**: inspects QQ NT's per-account named mutex, keyed by numeric
   *     `uin`. `baseDir` / `uid` are ignored.
   *   - **linux/macOS**: probes an fcntl lock on the account's `nt_msg.db`,
   *     located under `baseDir` via the string `uid`. Both are required; if
   *     either is missing this returns false. `uin` is ignored.
   *
   * The native layer never derives `baseDir` itself — the caller passes the
   * absolute QQ data directory (the folder containing the per-account dirs).
   */
  isQqLoggedIn(uin: string, baseDir?: string | null, uid?: string | null): boolean;
  /**
   * Extract appid / QUA from QQ NT's `major.node`. Used to feed launchQQ's
   * `appid` / `qua` so they match the installed QQ build exactly. `appid` is
   * always present; the rest are absent when the QUA anchor isn't found.
   */
  resolveAppidFromMajor(majorPath: string): AppidInfo;
  checkWindowsHelloAvailability(): WindowsHelloAvailabilityInfo;
  verifyWindowsHello(message: string, hwnd?: bigint | number | null): WindowsHelloVerifyInfo;

  // --- key acquisition ---
  /**
   * Derive the SQLCipher key for a QQ Channel (频道 / guild) database.
   * Guild databases (`gpro_v1-6_u_*.db`) use a per-file key derived from the
   * path and the account uin, separate from the main account `dbKey`.
   */
  getGuildDbKey(dbPath: string, uin: string): string;

  /**
   * Recover the image decryption key for a market-face (商城表情) package by
   * its `packetId` (a.k.a. emojiPackId). Fetches the package metadata, then
   * either reads the seed directly or brute-forces a timestamp window around
   * `updateTime` (TEA-decrypt first blocks → check `GIF8` header) in native
   * Rust. Resolves `null` when no key can be recovered (unknown pack / network
   * failure / window exhausted). Fast (single-digit ms) and result is stable,
   * so callers should cache it per packetId.
   */
  getMarketFaceKey(packetId: string): Promise<MarketFaceKeyResult | null>;

  /**
   * Zero-injection key scan: read the memory of the QQ process `pid` for the
   * NTQQ raw master key (HMAC_SHA1 anchor scan) and verify candidates against
   * the caller-supplied encrypted database at `dbPath` (e.g. `nt_msg.db`).
   * Mirrors `scan_key_from_database` in nt_helper.
   */
  scanKeyFromDatabase(dbPath: string, pid: number): Promise<KeyScanResult>;
  testDatabaseKey(dbPath: string, key: string): Promise<DatabaseProbeResult>;
  checkDatabaseHealth(
    dbPath: string,
    key: string,
    algo: DatabaseAlgorithms,
  ): Promise<DatabaseHealthResult>;

  // --- hook injection ---
  /**
   * Inject the hook into `pid` and wait until it is ready to send OIDB
   * packets. `uin` is required — the native hook no longer derives it from
   * the process — and is handed to the hook over the pipe on linux so it can
   * bind the right MSFService instance (injection resolves only once bound,
   * up to ~30s). The returned `QQInstanceStatus.uin` echoes the passed value.
   */
  injectAndGetStatus(pid: number, dllPath: string, uin: string): Promise<QQInstanceStatus>;
  injectAndGetStatusEmbedded(pid: number, uin: string): Promise<QQInstanceStatus>;
  /**
   * Wait until the hook observes a genuine post-login recv packet (pre-login
   * snapshots/commands are ignored). No longer part of the readiness flow on
   * linux — keep only as a manual probe.
   */
  waitForRealPacket(pid: number, timeoutMs: number): Promise<HookRecvPacketInfo>;

  // --- SQL (cached connection per dbPath) ---
  executeSql(dbPath: string, sql: string, params?: SqlValue[] | null): Promise<SqlRow[]>;
  executeSqlWithKey(
    dbPath: string,
    sql: string,
    key: string,
    algo: DatabaseAlgorithms,
    params?: SqlValue[] | null,
  ): Promise<SqlRow[]>;
  executeSqlWrite(dbPath: string, sql: string, params?: SqlValue[] | null): Promise<number>;
  executeSqlWriteWithKey(
    dbPath: string,
    sql: string,
    key: string,
    algo: DatabaseAlgorithms,
    params?: SqlValue[] | null,
  ): Promise<number>;
  closeDb(dbPath: string): number;
  closeAllDb(): number;
  /**
   * 只释放该 dbPath 的宽容（salvage）只读连接，严格连接一律不动。
   * 用户把宽容级别调回严格时用它。返回释放的连接数。
   */
  closeSalvageDb(dbPath: string): number;

  // --- SQL: 损坏宽容（salvage）只读通道 ---
  /**
   * 宽容只读查询。与 `executeSql*` 的差别只有两处，且都必须由上层显式授权：
   * 走独立的 salvage 只读连接；遇到损坏且 `level >= 1` 时换访问路径重试。
   *
   * 契约：**不会**因为"损坏"抛异常，而是返回 `ok: false` + 错误码，让调用方
   * 自己决定放弃还是切更小的一段；其它错误照旧抛错。
   */
  executeSqlSalvage(
    dbPath: string,
    sql: string,
    params?: SqlValue[] | null,
    level?: number | null,
  ): Promise<SalvageQueryOutcome>;
  executeSqlSalvageWithKey(
    dbPath: string,
    sql: string,
    key: string,
    algo: DatabaseAlgorithms,
    params?: SqlValue[] | null,
    level?: number | null,
  ): Promise<SalvageQueryOutcome>;
  /**
   * 分块容错扫描（L2）：把 key 区间切块读取，读不出来的块二分到 `minSpan` 再记成
   * "跳过区间"；`hints` 里的已知坏区间**不查**直接记账。
   *
   * SQL 契约（native 不解析 SQL）：末两个 `?` 是区间边界、结果按 key 升序、
   * **第一列是整数 key**（一般是 `rowid`）。
   */
  executeSqlSalvageScan(
    dbPath: string,
    sql: string,
    params: SqlValue[] | undefined | null,
    options: SalvageScanOptions,
    level?: number | null,
  ): Promise<SalvageScanOutcome>;
  executeSqlSalvageScanWithKey(
    dbPath: string,
    sql: string,
    key: string,
    algo: DatabaseAlgorithms,
    params: SqlValue[] | undefined | null,
    options: SalvageScanOptions,
    level?: number | null,
  ): Promise<SalvageScanOutcome>;
  /** 逐页复算页 HMAC，产出物理坏页清单（"坏页地图"）。 */
  scanBadPages(dbPath: string, key: string, algo: DatabaseAlgorithms): Promise<BadPageScanResult>;
  /**
   * 列出当前被 L3（整表放弃）隔离的表。进程内状态，条目有存活时间（默认 300 秒）。
   */
  listQuarantinedTables(): QuarantinedTable[];
  /**
   * 清掉隔离记录：只给 `dbPath` → 清该库；再加 `table` → 只清那一张；都不给 → 清全部。
   * 返回清掉的条目数。
   */
  clearQuarantinedTables(dbPath?: string | null, table?: string | null): number;

  // --- bulk decrypt ---
  fastDecryptDatabase(dbPath: string, outPath: string, key: string, algo: DatabaseAlgorithms): void;
  safeDecryptDatabase(dbPath: string, outPath: string, key: string, algo: DatabaseAlgorithms): void;

  // --- database repair ---
  /**
   * 修复损坏的库，产出一份可直接使用的新库：坏页扫描 → 解密（不校验页 HMAC，
   * 所以坏页也能救回大部分 cell）→ SQLite 官方 `recover` 重建 → 用 QQ 的参数
   * 重新加密 → 补回自定义头 → 自检。**源库只读**，产物写到 `options.outPath`。
   *
   * 进度通过 `onProgress` 持续回调（阶段 + 百分比 + 文案）。
   */
  recoverDatabase(
    options: RecoverOptions,
    onProgress?: (error: Error | null, progress: RecoverProgress) => void,
  ): Promise<RecoverReport>;
  /**
   * 把源库未合并的 WAL（`-wal` 里的帧）合并回主文件。
   *
   * QQ 的库是 WAL 模式：崩溃 / 被强杀后会留下带帧的 `-wal`，而解密、坏页扫描、修复都是
   * 页级读取，只看得到主文件 —— 修复前先调一次，最后那批改动才不会静默消失。合并不改
   * 内容（只是把帧里的整页镜像写回主文件对应的页）。
   *
   * **可选**：产物早于这个能力时不存在，调用方必须按"旧产物"处理（修复退回"如实告知
   * 用户 WAL 里的改动没进修复"），而不是当成致命错误。
   */
  checkpointWal?(
    dbPath: string,
    key: string,
    algo: DatabaseAlgorithms,
  ): Promise<WalCheckpointResult>;

  // --- custom packet send (protobuf-encoded body in, raw reply body out) ---
  /**
   * Send a custom OIDB packet. The body is wrapped in an OIDB envelope and the
   * command is formatted as `OidbSvcTrpcTcp.0x<command>_<subCommand>`.
   * `isUid` sets the UIN-form variant (reserved=1). Returns the inner reply body.
   */
  sendOidbPacket(
    pid: number,
    command: number,
    subCommand: number,
    body: Buffer,
    isUid: boolean,
  ): Promise<Buffer>;
  /**
   * Send a raw SSO packet with an explicit command string (no OIDB envelope) —
   * used for trpc services such as
   * `QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList`. The body must
   * already be protobuf-encoded; the raw reply body is returned.
   */
  sendPacket(pid: number, cmd: string, body: Buffer): Promise<Buffer>;

  // --- font conversion ---
  /**
   * Convert QQ's modified TTF (with FTFH/FTFG tables) to standard TTF.
   * Automatically detects if the input is already a standard TTF and copies it directly.
   *
   * 默认（不传 `options`）除了转换本身，还会：把私有的 `brsh`/`cglf` 编译成彩色字体
   * （`COLR` v1 + `CPAL` v0）、把 `eimg` 炫彩帧导到 `<输出名>_assets/`、并用本机的
   * `ots-sanitize` 预检产物。
   *
   * Returns a status string, e.g.:
   *   - "success: copied normal TTF" (standard TTF, no conversion needed)
   *   - "success: converted FTF to TTF; exported N eimg frame(s) (350x141) to …; OTS ok"
   *
   * 早于该开关的 nt_helper 会忽略第三个参数（只做转换），所以调用方不必探测版本。
   */
  convertFont(inputPath: string, outputPath: string, options?: ConvertFontOptions): string;

  // --- dress offline resource index (local .dat bundles, no protocol needed) ---
  /**
   * Look up one dress resource's download URL from the local bundle
   * (`resources/dress/{font|bubble|widget}.dat`; the AES key is baked into the
   * binary at build time and derived from the commit SHA in CI, so all
   * platforms share one key). Pure-local: works with no online QQ and in
   * fully-offline mode. Returns `null` when the bundle is missing,
   * undecryptable, or the record does not exist - callers fall back to the
   * protocol (scupdate) query.
   *
   * `dtype`: "font" | "bubble" | "widget"
   * `itemId`: dress item id
   * `name`: part name - config.json / static.zip / other.zip / aio_50.png /
   *   xydata.js / main / fzfont
   */
  queryDressResourceUrl(dtype: string, itemId: string, name: string): DressResourceUrl | null;
}

// ---------- ninebird_addon.node — launch bootstrap -----------------------

/**
 * Arguments accepted by `ninebird_addon.launchQQ`. The addon launches QQ
 * with the hook pre-loaded and forwards NDJSON events back over the IPC
 * channel named by `pipeName`.
 *
 * The interface is shared across platforms; a few fields carry different
 * concrete values per OS:
 *   - `hookDllPath`  win32: `NineBirdHook.dll`  ·  linux: `ninebird_launcher.so`
 *   - `pipeName`     win32: `\\.\pipe\…`         ·  linux: a unix socket path
 *   - `qqntJsonPath` win32: real spoof json      ·  linux: any existing file (placeholder)
 *
 * Both login flows (QR scan / quick UIN) take the same shape — the
 * difference is which `loadJsPath` is passed (`qr-dbkey.js` vs
 * `quick-dbkey.js`) and whether `uin` is supplied.
 */
export interface LaunchQqOptions {
  qqExePath: string;
  hookDllPath: string;
  qqntJsonPath: string;
  loadJsPath: string;
  pipeName: string;
  loaderDir?: string;
  /** Required only for the quick-login flow. */
  uin?: string;
  timeoutMs?: number;
  /**
   * appid / qua matched to the installed QQ build. Resolved by an upper layer
   * from QQ's `major.node` (`resolveAppidFromMajor`) and passed through here;
   * the loader falls back to a per-platform default when absent. A mismatched
   * value gets the account kicked from QQ's login list (140022017) — never
   * guess these.
   */
  appid?: string;
  qua?: string;
  /** Default true — QQ's stdio is silenced. false inherits the parent's stdio. */
  headless?: boolean;
}

export interface LaunchQqResult {
  success: boolean;
  pid: number;
  error?: string;
}

export interface NineBirdBootBinding {
  launchQQ(opts: LaunchQqOptions): Promise<LaunchQqResult>;
}

// ---------- NDJSON events flowing back on the pipe -----------------------

/** Quick-login: emitted once after QQ has read its local login.db. */
export interface NineBirdLoginListEvent {
  kind: 'login-list';
  list: LoginAccount[];
}

/**
 * One entry of the account-list flow. Shape comes straight from QQ's own
 * `getLoginList()` (via `account-list.js`), so it differs from
 * `LoginAccount` (decrypted login.db): there's no `a1Key`, but we DO get
 * the live `isQuickLogin` flag plus nickname/avatar QQ already resolved.
 */
export interface NineBirdAccountListItem {
  /** QQ number. */
  uin: string;
  /** Long uid. */
  uid: string;
  /** Display name QQ has cached. */
  nickName: string;
  /** CDN avatar URL (may 404 if stale). */
  faceUrl: string;
  /** Local on-disk avatar path. */
  facePath: string;
  /** QQ's internal login-type tag. */
  loginType: number;
  /** True when QQ can quick-login this account without a QR scan. */
  isQuickLogin: boolean;
  /** True when QQ is configured to auto-login this account. */
  isAutoLogin: boolean;
}

/**
 * Account-list: emitted once after `account-list.js` reads QQ's login list.
 * Shares the `login-list` wire `kind` with quick-login, but carries the
 * richer `NineBirdAccountListItem` payload.
 */
export interface NineBirdAccountListEvent {
  kind: 'login-list';
  list: NineBirdAccountListItem[];
}

/** QR-login: emitted with the URL to encode into a QR code. */
export interface NineBirdQrcodeEvent {
  kind: 'qrcode';
  url: string;
}

/** QR-login: emitted as the QR state transitions (scanned / confirmed / …). */
export interface NineBirdQrcodeStateEvent {
  kind: 'qrcode-state';
  state: string;
}

/**
 * Emitted by both login loaders just BEFORE `result`, carrying the `p_skey`
 * they collected on the way out (domain → key). Best-effort: the loaders never
 * fail a login over a missing pskey, so `success: false` is routine.
 */
export interface NineBirdPskeyEvent {
  kind: 'pskey';
  success: boolean;
  /** Domain → p_skey. Present when `success`. */
  pskey?: Record<string, string>;
  error?: string;
}

/** Terminal event for both flows. */
export interface NineBirdResultEvent {
  kind: 'result';
  success: boolean;
  dbkey?: string;
  error?: string;
}

export type NineBirdEvent =
  | NineBirdLoginListEvent
  | NineBirdQrcodeEvent
  | NineBirdQrcodeStateEvent
  | NineBirdPskeyEvent
  | NineBirdResultEvent;

// ---------- Loaded bundle -----------------------------------------------

/**
 * What `loadNative()` returns: both .node addons + every resource path the
 * caller needs to hand to `launchQQ`. Resource paths are absolute and
 * already verified to exist.
 */
export interface NativeBundle {
  ntHelper: NtHelperBinding;
  nineBirdBoot: NineBirdBootBinding;
  /** Paths to companion resource files NineBird needs at launch time. */
  resources: NineBirdResources;
}

export interface NineBirdResources {
  /** Native NineBird dir (contains NineBird.node + the addon; the loader scripts find `NineBird.node` here via NINEBIRD_LOADER_DIR). */
  loaderDir: string;
  /** Hook DLL injected into QQ on launch (win32 only for now). */
  hookDllPath: string;
  /** Spoofed `qqnt.json` placed alongside the hook. */
  qqntJsonPath: string;
  /** The auxiliary `NineBird.node` that quick-dbkey/qr-dbkey require inside QQ. */
  nineBirdAddonPath: string;
  /** Script loaded inside QQ for the QR-code login flow. Lives in resources/ninebird-runtime (platform-independent). */
  qrDbkeyJsPath: string;
  /** Script loaded inside QQ for the quick (UIN-cached) login flow. Lives in resources/ninebird-runtime. */
  quickDbkeyJsPath: string;
  /**
   * Script loaded inside QQ to enumerate the local login list without
   * decrypting login.db ourselves. Used as the `decryptLoginDb` fallback.
   */
  accountListJsPath: string;
}

// ---------- DB-subset alias used by @weq/db ------------------------------

/** 宽容（salvage）只读查询的结果。 */
export interface SalvageQueryOutcome {
  /** 查询到的行；`ok === false` 时为空。 */
  rows: SqlRow[];
  /** 是否拿到了可用结果。 */
  ok: boolean;
  /** 是否发生了降级（换了访问路径后成功）。`ok === false` 时为 false。 */
  degraded: boolean;
  /**
   * 实际用到的级别：0 = 原路径，1 = 索引退化，2 = 跳过了坏区间，3 = 该表已被隔离。
   */
  levelUsed: number;
  /** `'none'` | `'corrupt'` | `'not-a-database'` | `'quarantined'`。 */
  errorKind: string;
  /** SQLite 主错误码（11 = CORRUPT，26 = NOTADB）；无错误时缺省。 */
  errorCode?: number | null;
  /** 原始错误文案，与严格模式报出来的那条一致。短路时没有文案。 */
  errorMessage?: string | null;
  /** 本次是否真的用 `NOT INDEXED` 重试过。 */
  retriedWithNotIndexed: boolean;
  /** 这条语句针对的表（解析不出来时缺省）。整表放弃就是按它判定的。 */
  table?: string | null;
  /** 该表是否已被 L3 隔离（`true` 表示这次**根本没查**）。 */
  quarantined: boolean;
}

/**
 * 一个键区间，语义与扫描窗口一致（`(lo, hi]`）。
 *
 * 边界是 `bigint`：QQ 的 `rowid` 实测在 `7.7e18` 量级，越过 `2^53` 之后 `number` 会被
 * 静默取整（实测偏差 48），"从哪断的"会整个错位。超出 `2^53` 的数字**必须**用 `bigint`
 * 传，native 会报错而不是替你取整。
 */
export interface SalvageKeyRange {
  /** 区间下界（不含）。 */
  lo: bigint;
  /** 区间上界（含）。 */
  hi: bigint;
}

/**
 * 分块容错扫描的配置。
 *
 * `hints` 的**正确用法**是把上一次结果的 `skipped` 原样回填：那里的 `lo` / `hi` 就是
 * 当时查询用的窗口边界（`lo` 侧开、`hi` 侧闭），相邻的跳过区间会被自动合并成一段，
 * 正好盖住全部读不出来的 key，两侧可读区间也不会被多切一刀。
 */
export interface SalvageScanOptions {
  /** 扫描下界（不含）。 */
  lo: bigint;
  /**
   * 扫描上界（含）；省略 = **一直读到表尾**。
   *
   * 开放上界必须配 `seekSql`：否则扫描器不知道何时停，native 会直接报错（而不是
   * 跑一个永远跑不完的扫描）。
   */
  hi?: bigint | null;
  /** 每块覆盖的 key 跨度；默认 4096。 */
  chunk?: number;
  /** 二分的下限跨度：降到这里仍坏就记为跳过；默认 1。 */
  minSpan?: number;
  /** 预算：最多允许跳过几处**损坏区域**（相邻同类区间会合并）；默认 256。 */
  maxSkippedRanges?: number;
  /** 预算：最多允许跳过多少 key 跨度；默认 8192。注意它**不是行数**。 */
  maxSkippedSpan?: number;
  /** 已知坏区间（一般来自上一次扫描的结果）。只在 `level >= 2` 时生效。 */
  hints?: SalvageKeyRange[];
  /**
   * **已知键探针**：一条"取下一个存在的键"的 SQL，末尾追加**一个**参数（当前键），
   * 返回 `> 当前键` 的最小键（取第一列；没有更大的键就返回空/NULL）。
   *
   * 例：`SELECT MIN(rowid) FROM group_msg_table WHERE "40027" = ?1 AND rowid > ?2`。
   * 过滤条件必须与扫描语句一致，否则 native 会按契约违规报错。给了它，空键区间
   * **一次探针**就跳过去；没有它，稀疏键空间只能按固定步长走（不可用）。
   */
  seekSql?: string;
  /**
   * 最多允许多少个窗口（只在没有 `seekSql` 时检查）；默认 100000。
   *
   * 防呆而不是预算：没有探针时扫描器只能按固定步长推进，`hi = MAX(rowid)` 这种调用
   * 要切 `1.8e15` 个窗口。这种调用会被**开工前拒绝**。
   */
  maxWindows?: number;
}

/**
 * 一处"读不出来"的区间。
 *
 * 区间内部到底有多少行**无法得知**（读不出来就是读不出来），所以位置提示只能用前后
 * 邻居表达，**不报行数** —— 报告里不允许伪造精确数字。
 *
 * ⚠️ `hi - lo` 是**键跨度，不是行数上界**：同一个键可能对应多行（共享 `seq` 的灰条 /
 * 贴表情），实测就有"丢 21 行而跨度只有 18"。
 */
export interface SalvageSkippedRange {
  /** 左邻：跳过之前最后一条成功读出的 key；缺省 = 从头就坏。 */
  prevKey?: bigint | null;
  /** 右邻：跳过之后第一条成功读出的 key；缺省 = 一直坏到扫描结束。 */
  nextKey?: bigint | null;
  /** 实际执行失败的块的边界（诊断用）。 */
  lo: bigint;
  hi: bigint;
  /** `'corrupt'` | `'not-a-database'`；`'hint'` 表示按提示直接跳过、**根本没查**。 */
  errorKind: string;
  /** SQLite 主错误码（11 / 26）；提示区间没有错误码。 */
  errorCode?: number | null;
}

/**
 * 一次分块容错扫描的结果。
 *
 * `ok === false` 只有三种情况，且都会把 `rows` 清空 —— 绝不允许把部分数据当成完整数据：
 * 超出降级预算（`budgetExhausted`）；`level < 2`（损坏且 L1 也救不回来）；该表已被隔离
 * （`quarantined`）。
 *
 * 失败时 `skipped` / `skippedSpan` **照原样保留**："丢在哪一段"是失败报告里最有用的一句。
 */
export interface SalvageScanOutcome {
  /** 读出来的行（`ok === false` 时为空）。 */
  rows: SqlRow[];
  /** 是否拿到了可用结果。 */
  ok: boolean;
  /** 是否发生了降级（换过访问路径或跳过过区间）。 */
  degraded: boolean;
  /** 实际用到的级别：0 / 1 / 2 / 3。 */
  levelUsed: number;
  /** `'none'` | `'corrupt'` | `'not-a-database'` | `'quarantined'`。 */
  errorKind: string;
  errorCode?: number | null;
  /** 最早那处损坏的原始文案（根因，不是最后一次重试的结果）。 */
  errorMessage?: string | null;
  /** 跳过区间清单（`ok === true` 时才有意义）；每条都带自己的来源。 */
  skipped: SalvageSkippedRange[];
  /** 实际执行了多少次查询（含二分与 L1 重试），用来解释耗时。 */
  queries: number;
  /** 是否因为超出降级预算而整体放弃。 */
  budgetExhausted: boolean;
  /** 读出的行数（= `rows.length`）。 */
  rowCount: number;
  /**
   * 跳过区间的 key 跨度总和。
   *
   * ⚠️ **不是丢失行数的上界**：同一个键可能对应多行（共享 `seq` 的灰条、贴表情），
   * 实测"丢 21 行而跨度只有 18"。报告只能说"这一段读不出来"，不能说"最多丢 N 行"。
   */
  skippedSpan: number;
  /** 这条语句针对的表（解析不出来时缺省）。 */
  table?: string | null;
  /** 该表是否已被 L3 隔离（`true` 表示这次**根本没扫**）。 */
  quarantined: boolean;
}

/** 一张被 L3（整表放弃）隔离的表。 */
export interface QuarantinedTable {
  /** 数据库文件路径。 */
  dbPath: string;
  /** 表名。 */
  table: string;
  /** 触发隔离的损坏类型。 */
  errorKind: string;
  /** 首次隔离时间（Unix 秒）。 */
  since: number;
  /** 隔离时已连续失败次数。 */
  failures: number;
}

/** 坏页扫描（"坏页地图"）的结果。 */
export interface BadPageScanResult {
  pageSize: number;
  pageCount: number;
  /** 物理坏页（1-based 页号，页 HMAC 校验失败）。 */
  badPages: number[];
  /**
   * 全零页。SQLCipher 把整页全零当作"读到文件尾之后的短读"，是否算损坏取决于
   * 库有没有开 autovacuum，所以单独列出。
   */
  zeroPages: number[];
  /** 文件尾不足一页的残余字节数。 */
  trailingBytes: number;
  /**
   * 本次是否真的校验了页 HMAC。`false` 表示该库没开页 HMAC，此时 `badPages`
   * 必然为空 —— 地图**没有意义**，界面必须如实告知，而不是当成"库是好的"。
   */
  usedHmac: boolean;
  /**
   * QQ 头之后就是一个**明文** SQLite 库（没有加密）。
   *
   * 实测：对明文库硬跑页 HMAC 会得到"1217 / 1217 页全坏"的误导结论，所以 native 认出
   * 这种情况后直接早退 —— `badPages` 为空、`usedHmac` 为 `false`。界面要说的是
   * "这不是加密库，坏页地图不适用"，而不是"全坏"。
   */
  plaintext: boolean;
  /** 文件里 QQ 自定义头的长度（0 或 1024）。 */
  headerOffset: number;
  /** 扫描结束时的文件大小（地图缓存的失效判据）。 */
  fileSize: number;
  /** 扫描时间（Unix 秒）。 */
  scannedAt: number;
}

/**
 * Subset of `NtHelperBinding` the db package uses for its `QqDb` handle.
 * Carved out so unit tests can construct `QqDb` with a stub binding
 * without depending on the full native surface.
 */
export type NativeBinding = Pick<
  NtHelperBinding,
  | 'executeSql'
  | 'executeSqlSalvageScan'
  | 'executeSqlSalvageScanWithKey'
  | 'listQuarantinedTables'
  | 'clearQuarantinedTables'
  | 'executeSqlWithKey'
  | 'executeSqlWrite'
  | 'executeSqlWriteWithKey'
  | 'closeDb'
  | 'closeAllDb'
>;
