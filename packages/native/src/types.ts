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
  /** "Instance" path: ask a running, logged-in QQ for the db key via OIDB. */
  requestDecryptKey(pid: number, dbPath: string): Promise<string>;

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

  // --- bulk decrypt ---
  fastDecryptDatabase(dbPath: string, outPath: string, key: string, algo: DatabaseAlgorithms): void;
  safeDecryptDatabase(dbPath: string, outPath: string, key: string, algo: DatabaseAlgorithms): void;

  // --- OIDB service helpers (JSON-stringified results) ---
  fetchDownloadRkeys(pid: number): Promise<string>;
  fetchClientKey(pid: number): Promise<string>;
  fetchSkey(pid: number, uin: string): Promise<string>;
  fetchPskey(pid: number, uin: string, domain: string): Promise<string>;
  computeBkn(skey: string): number;

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
   * Returns a status string:
   *   - "success: copied normal TTF" (standard TTF, no conversion needed)
   *   - "success: converted FTF to TTF" (magic TTF converted to standard)
   */
  convertFont(inputPath: string, outputPath: string): string;

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

/**
 * Subset of `NtHelperBinding` the db package uses for its `QqDb` handle.
 * Carved out so unit tests can construct `QqDb` with a stub binding
 * without depending on the full native surface.
 */
export type NativeBinding = Pick<
  NtHelperBinding,
  | 'executeSql'
  | 'executeSqlWithKey'
  | 'executeSqlWrite'
  | 'executeSqlWriteWithKey'
  | 'closeDb'
  | 'closeAllDb'
>;
