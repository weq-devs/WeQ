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
export interface NtHelperBinding {
  // --- init / health ---
  getInitStatus(): InitStatus;
  setLogPath(path: string): void;

  // --- QQ process / login detection ---
  probeQqLoginInfo(pid: number): QqPortLoginInfo | null;
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
  getQqProcesses(): number[];
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
  
  testDatabaseKey(dbPath: string, key: string): Promise<DatabaseProbeResult>;
  checkDatabaseHealth(dbPath: string, key: string, algo: DatabaseAlgorithms): Promise<DatabaseHealthResult>;

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
  executeSql(
    dbPath: string,
    sql: string,
    params?: SqlValue[] | null,
  ): Promise<SqlRow[]>;
  executeSqlWithKey(
    dbPath: string,
    sql: string,
    key: string,
    algo: DatabaseAlgorithms,
    params?: SqlValue[] | null,
  ): Promise<SqlRow[]>;
  executeSqlWrite(
    dbPath: string,
    sql: string,
    params?: SqlValue[] | null,
  ): Promise<number>;
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
