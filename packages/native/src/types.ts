/**
 * Public type surface of the `@weq/native` package.
 *
 * Mirrors `Qrypt-Native/nt_helper/src/lib.rs` (DB / detect / inject / OIDB)
 * and the `launchQQ` entry of `NineBirdBoot.node` (login bootstrap).
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

export interface DatabaseAlgorithms {
  pageHmacAlgorithm: string;
  kdfHmacAlgorithm: string;
}

export interface DatabaseProbeResult {
  success: boolean;
  pageHmacAlgorithm?: string;
  kdfHmacAlgorithm?: string;
}

/** Status returned after injecting the hook DLL into a QQ process. */
export interface QQInstanceStatus {
  pid: number;
  loggedIn: boolean;
  uin: string;
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

  // --- QQ process / login detection ---
  probeQqLoginInfo(pid: number): QqPortLoginInfo | null;
  decryptLoginDb(loginDbPath: string, key: string, algo: DatabaseAlgorithms): LoginAccount[];
  getQqProcesses(): number[];
  /**
   * Mutex-lock probe: is the QQ account `uin` currently logged in on this
   * machine? Works without a pid — QQ holds a per-uin named mutex while the
   * account is online. Used to attribute the single running QQ process to a
   * concrete account when port-probing can't (see GlobalConfigService).
   */
  isQqLoggedIn(uin: string): boolean;

  // --- key acquisition ---
  /** "Instance" path: ask a running, logged-in QQ for the db key via OIDB. */
  requestDecryptKey(pid: number, dbPath: string): Promise<string>;
  
  testDatabaseKey(dbPath: string, key: string): Promise<DatabaseProbeResult>;

  // --- hook injection ---
  injectAndGetStatus(pid: number, dllPath: string): Promise<QQInstanceStatus>;
  injectAndGetStatusEmbedded(pid: number): Promise<QQInstanceStatus>;

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
}

// ---------- NineBirdBoot.node — launch bootstrap -------------------------

/**
 * Arguments accepted by `NineBirdBoot.launchQQ`. The bootstrap launches a
 * QQ.exe with the hook DLL pre-loaded and forwards NDJSON events back via
 * a Named Pipe the caller hands in.
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
  /** Directory containing all NineBird companion files. */
  loaderDir: string;
  /** Hook DLL injected into QQ on launch (win32 only for now). */
  hookDllPath: string;
  /** Spoofed `qqnt.json` placed alongside the hook. */
  qqntJsonPath: string;
  /** The auxiliary `NineBird.node` that quick-dbkey/qr-dbkey require inside QQ. */
  nineBirdAddonPath: string;
  /** Script loaded inside QQ for the QR-code login flow. */
  qrDbkeyJsPath: string;
  /** Script loaded inside QQ for the quick (UIN-cached) login flow. */
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
