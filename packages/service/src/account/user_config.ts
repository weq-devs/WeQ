/**
 * AccountConfigService — manages per-account persistent configuration.
 *
 * Saves credentials (uin, dbKey, algo) plus display metadata (nickname,
 * avatar) to a local file so the user can "现有配置" next time without
 * re-detecting / re-scanning.
 *
 * Identity model: the PRIMARY KEY is the account's user-data directory
 * (`…\Tencent Files\<uin>`), NOT the uin. The same uin opened from two
 * different data directories is two independent records — otherwise a
 * future "decrypt backup database" step would collide. The on-disk file
 * name is derived from (uin + dataDir) via {@link accountConfigId}.
 *
 * Path: <appDataRoot>/config/accounts/<configId>.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { AnnualReportPreferences } from './annual_report/types';
import type { DatabaseAlgorithms } from '@weq/native';
import { getLogger, logErrorContext } from '../common/logger';

/**
 * A download rkey issued by QQ's OIDB service (via `fetchDownloadRkeys`). Used
 * to authenticate CDN media downloads when a file isn't on disk locally.
 *
 * Normalised from the native JSON (`type_`/`ttl_seconds`/`create_time`). The
 * `rkey` string already carries its `&rkey=` URL prefix, as QQ returns it.
 */
export interface DownloadRkey {
  /** URL fragment as returned by QQ, e.g. `&rkey=CAQS…`. */
  rkey: string;
  /** Scene: 10 = c2c / private chat, 20 = group chat. */
  type: number;
  /** Validity window in seconds, measured from {@link createTime}. */
  ttlSeconds: number;
  /** Unix seconds the rkey was issued. Expiry = createTime + ttlSeconds. */
  createTime: number;
  /**
   * Optional absolute expiry (unix seconds). External rkey servers only return
   * the expiry moment, not the issue time, so we carry it here instead of
   * deriving it from createTime + ttlSeconds.
   */
  expiredAt?: number;
}

/** Absolute expiry of an rkey in unix milliseconds. */
export function rkeyExpiryMs(r: DownloadRkey): number {
  if (r.expiredAt != null) return r.expiredAt * 1000;
  return (r.createTime + r.ttlSeconds) * 1000;
}

/**
 * A `clientkey` credential issued by QQ's OIDB service (via `fetchClientKey`).
 * Short-lived (≈30 min) token used to authenticate web/cgi calls to QQ's
 * services on this account's behalf.
 *
 * Normalised from the native JSON (`client_key`/`key_index`/`expire_time`).
 * Unlike an rkey, QQ returns only a TTL (no issue time), so we stamp
 * {@link fetchedAt} ourselves when we harvest it.
 */
export interface ClientKey {
  /** The client_key credential (hex string). */
  clientKey: string;
  /** Server-side key slot index returned alongside the key. */
  keyIndex: string;
  /** Validity window in seconds, measured from {@link fetchedAt}. */
  ttlSeconds: number;
  /** Unix milliseconds we fetched the key (QQ gives only a TTL, not an issue time). */
  fetchedAt: number;
}

/** Absolute expiry of a clientkey in unix milliseconds. */
export function clientKeyExpiryMs(c: ClientKey): number {
  return c.fetchedAt + c.ttlSeconds * 1000;
}

export interface AccountConfig {
  /**
   * Stable record id derived from (uin, dataDir). Filename is
   * `<configId>.json`. Older configs written before this field existed fall
   * back to `uin` at read time.
   */
  configId: string;
  uin: string;
  /**
   * The account's string uid (the `u_...` form). Needed on linux to derive the
   * on-disk account directory `nt_qq_<md5(md5(uid)+"nt_kernel")>`; unused on
   * win32 (which keys directories by numeric uin). Absent on records written
   * before this field existed.
   */
  uid?: string;
  /**
   * SQLCipher key. Empty string for already-decrypted static accounts that
   * opened without a key (the record is always written with at least '').
   */
  dbKey: string;
  /**
   * Per-database cryptographic algorithms, keyed by filename (e.g. `'nt_msg.db'`).
   * Different databases in the same directory may use different cipher parameters.
   * Empty object for plain (already-decrypted) static accounts.
   *
   * Migration: older records carry a single `algo` field; {@link normalizeAccountConfig}
   * converts it to `{ 'nt_msg.db': algo }` transparently at read time.
   */
  algos: Record<string, DatabaseAlgorithms>;
  /**
   * Absolute path to this account's user-data directory
   * (`…\Tencent Files\<uin>`). The true primary key; same uin + different
   * dataDir ⇒ separate record.
   */
  dataDir?: string;
  /** Last seen display name / nickname (for the picker). */
  displayName?: string;
  /** Cached avatar URL (for the picker), if resolved. */
  avatarUrl?: string;
  /** Unix milliseconds of last login. */
  lastLoginAt: number;
  /** Per-account annual-report page collection and ordering preferences. */
  annualReport?: AnnualReportPreferences;

  /** True while a logged-in QQ.exe instance for this account is running. */
  qqOnline?: boolean;
  /** PID of that running QQ instance, or null when none is online. */
  qqPid?: number | null;
  /** Latest download rkeys harvested from the online instance. */
  rkeys?: DownloadRkey[];
  /** Unix ms the rkeys were last refreshed. */
  rkeyUpdatedAt?: number;
  /** Latest clientkey harvested from the online instance (when 自动注入 QQ is on). */
  clientKey?: ClientKey;
  /**
   * True for static / offline accounts opened from a directory of
   * already-decrypted (or SQLCipher-keyed) databases. Drives the
   * 「静态」 badge in the account list and chooses `setStaticAccount`
   * vs `setAccount` on re-open.
   */
  static?: boolean;
  /**
   * True when the static account was identified as an Android (phone) backup —
   * directory contains a `gpro_v*_uid.db` file and the SQLCipher key can be
   * auto-derived. Shows the Android icon instead of the generic database icon.
   */
  mobile?: boolean;
  /**
   * 静态账号「关联本机原生目录」：探测到的本机同账号数据目录（`platform.accountDir`）。
   * 只用于设置页展示——真正生效的路径每次开账号都重新探测，因为用户可能改了
   * 全局数据目录覆盖。探测不到则不写。
   */
  nativeMediaDir?: string;
  /**
   * 是否允许从 {@link AccountConfig.nativeMediaDir} 读媒体。探测到就默认开（缺省视为
   * true），用户可在设置页关掉——关掉后所有媒体目录解析为 null，聊天里的图片/语音
   * 自动回落到 CDN 补全（本地 miss 本来就走这条路）。
   */
  nativeMediaEnabled?: boolean;
  /**
   * p_skey per domain, harvested by the ninebird loader during login (while QQ
   * was still alive). Seeds `WebCredentialProvider` so the first home-dress
   * fetch works without a hook round-trip.
   */
  loginPskey?: Record<string, string>;
  /** 首页个性装扮快照（挂件/名片/浮屏/个性标签 + 气泡/字体 id），在线注入后写入。 */
  homeDress?: {
    widgetUrl: string;
    cardUrl: string;
    cardVideoUrl: string;
    screenUrl: string;
    tags: string[];
    /** 正在用的气泡 itemId。渲染侧据此拼九宫格外链（纯 itemId 可预测，无需下载凭证）。 */
    bubbleId?: number;
    /** 正在用的气泡款名（如「简约鲸鱼」）。装扮页显示用，缺省时只能显示 id。 */
    bubbleName?: string;
    /** 正在用的气泡预览图直链。**目录段有时是服务端 nonce，推不出来**，所以存 url。 */
    bubblePreviewUrl?: string;
    /** 正在用的聊天字体 itemId（不含界面字体 305）。字体文件得走 protocol 另取。 */
    fontId?: number;
    /** 正在用的字体款名。 */
    fontName?: string;
    /** 正在用的字体预览图直链。同 bubblePreviewUrl，目录段常是 nonce（实测 59500 就是）。 */
    fontPreviewUrl?: string;
    /**
     * 正在用的聊天背景图（720×1280 原图直链）。与 screenUrl（浮屏）不是一回事。
     * 这里存 url 而非 itemId —— 背景的目录段是服务端 nonce，推不出来。
     */
    chatBgUrl?: string;
    /** 正在用的头像挂件 itemId（appId 4）。渲染侧据此换动画帧。 */
    widgetId?: number;
    /** 正在用的挂件款名。 */
    widgetName?: string;
    /** 正在用的挂件预览图直链（newPreview2）。 */
    widgetPreviewUrl?: string;
  };
}

/** Metadata threaded in from the open flow to enrich the saved record. */
export interface AccountConfigMetadata {
  displayName?: string;
  avatarUrl?: string;
  dataDir?: string;
  /** Account string uid (`u_...`), needed for linux account-dir derivation. */
  uid?: string;
  /** Set when opening a static (offline) account so the badge / re-open
   *  path know which flow to use. */
  static?: boolean;
  /** Set alongside `static` when the backup was identified as an Android phone
   *  backup (auto-derived SQLCipher key). Shows the Android icon in the picker. */
  mobile?: boolean;
  /** Local native data directory detected for this static account, if any. */
  nativeMediaDir?: string;
}

/**
 * Stable, filesystem-safe id for an account record. Uses the uin as a
 * human-readable prefix and a short hash of the data directory as the
 * disambiguator so the same uin opened from two dirs maps to two files.
 *
 * When `dataDir` is absent we fall back to the bare uin — keeps the common
 * single-directory case tidy and back-compatible with legacy `<uin>.json`.
 */
export function accountConfigId(uin: string, dataDir?: string | null): string {
  if (!dataDir) return uin;
  return `${uin}_${shortHash(dataDir)}`;
}

/** djb2 → 8-char hex. Not cryptographic — just a stable directory tag. */
function shortHash(input: string): string {
  let h = 5381;
  const normalized = input.trim().toLowerCase();
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) + h + normalized.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export class AccountConfigService {
  private readonly accountsDir: string;
  /**
   * Record id for the file this service reads/writes. Seeded from the bare uin
   * and refined to the (uin, dataDir) id on the first {@link save} — which the
   * open flow always runs before any {@link patch}.
   */
  private currentConfigId: string;
  private readonly logger: ReturnType<typeof getLogger>;

  constructor(
    private readonly session: AccountSession,
    appDataRoot: string,
  ) {
    this.accountsDir = join(appDataRoot, 'config', 'accounts');
    this.currentConfigId = accountConfigId(this.session.context.uin);
    this.logger = getLogger().child({
      scope: 'account-config',
      accountUin: this.session.context.uin,
    });
  }

  /**
   * Save the current session's credentials + metadata to disk, keyed by the
   * account's data directory (see {@link accountConfigId}). Preserves any
   * volatile fields (online/pid/rkeys) already on the existing record.
   */
  save(metadata: AccountConfigMetadata = {}): void {
    const uin = this.session.context.uin;
    const configId = accountConfigId(uin, metadata.dataDir);
    this.currentConfigId = configId;
    const prev = this.readRecord();
    const config: AccountConfig = {
      ...prev,
      configId,
      uin,
      dbKey: this.session.context.dbKey,
      algos: this.session.context.algos,
      ...(metadata.uid ? { uid: metadata.uid } : {}),
      ...(metadata.dataDir ? { dataDir: metadata.dataDir } : {}),
      ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
      ...(metadata.avatarUrl ? { avatarUrl: metadata.avatarUrl } : {}),
      ...(metadata.static === true ? { static: true } : {}),
      ...(metadata.mobile === true ? { mobile: true } : {}),
      // Always overwrite (not merge): the probe re-runs on every open, and a
      // stale path left over from a since-changed data-dir override would show
      // the user a directory we are no longer reading from.
      nativeMediaDir: metadata.nativeMediaDir,
      lastLoginAt: Date.now(),
    };
    this.writeRecord(config);
    this.logger.info('saved account config', {
      event: 'save-account-config',
      configId,
      dataDir: metadata.dataDir ?? null,
      static: metadata.static === true,
    });
  }

  /** Read the current account's record from disk, or null if not yet written. */
  getRecord(): AccountConfig | null {
    return this.readRecord();
  }

  /** Update the online flag + pid without disturbing the rest of the record. */
  setOnline(qqOnline: boolean, qqPid: number | null): void {
    this.patch({ qqOnline, qqPid });
    this.logger.info('updated account online state', {
      event: 'set-online',
      qqOnline,
      qqPid,
    });
  }

  /** Replace the stored download rkeys (and stamp the refresh time). */
  setRkeys(rkeys: DownloadRkey[]): void {
    this.patch({ rkeys, rkeyUpdatedAt: Date.now() });
    this.logger.info('stored download rkeys', {
      event: 'set-rkeys',
      count: rkeys.length,
      types: rkeys.map((r) => r.type),
    });
  }

  /** Replace the stored clientkey. */
  setClientKey(clientKey: ClientKey): void {
    this.patch({ clientKey });
    this.logger.info('stored client key', {
      event: 'set-client-key',
      ttlSeconds: clientKey.ttlSeconds,
      keyIndex: clientKey.keyIndex,
    });
  }

  /** Persist the home-dress snapshot (widget / card / screen / tags). */
  setHomeDress(homeDress: AccountConfig['homeDress']): void {
    this.patch({ homeDress });
    this.logger.info('stored home dress snapshot', { event: 'set-home-dress' });
  }

  /**
   * Toggle reading media from the detected native directory (static accounts).
   * Takes effect immediately — the platform wrapper reads this on every path
   * lookup, so no account reopen is needed.
   */
  setNativeMediaEnabled(enabled: boolean): void {
    this.patch({ nativeMediaEnabled: enabled });
    this.logger.info('updated native media binding', {
      event: 'set-native-media-enabled',
      enabled,
    });
  }

  /** Persist the user's annual-report page collection and ordering. */
  setAnnualReportPreferences(annualReport: AnnualReportPreferences): void {
    this.patch({ annualReport });
    this.logger.info('stored annual report preferences', {
      event: 'set-annual-report-preferences',
      mode: annualReport.mode,
      enabledCount: annualReport.enabledPageIds.length,
    });
  }

  /** Persist p_skey harvested during the ninebird login flow. */
  setLoginPskey(loginPskey: Record<string, string>): void {
    this.patch({ loginPskey });
    this.logger.info('stored login pskey', {
      event: 'set-login-pskey',
      domains: Object.keys(loginPskey),
    });
  }

  private patch(partial: Partial<AccountConfig>): void {
    const existing = this.readRecord();
    if (!existing) return; // save() seeds the record before any patch
    this.writeRecord({ ...existing, ...partial });
  }

  private readRecord(): AccountConfig | null {
    const filePath = join(this.accountsDir, `${this.currentConfigId}.json`);
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as AccountConfig;
      return normalizeAccountConfig(raw);
    } catch {
      return null;
    }
  }

  private writeRecord(config: AccountConfig): void {
    mkdirSync(this.accountsDir, { recursive: true });
    const filePath = join(this.accountsDir, `${config.configId}.json`);
    try {
      writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error('failed to write account config', {
        event: 'write-account-config-failed',
        filePath,
        configId: config.configId,
        ...logErrorContext(error),
      });
      throw error;
    }
  }
}

/**
 * Normalize an `AccountConfig` read from disk, migrating older records that
 * carry a single `algo: DatabaseAlgorithms` field to the new per-db
 * `algos: Record<string, DatabaseAlgorithms>` shape.
 *
 * Exported so `UserConfigService.listAccountConfigs` (in bootstrap) can apply
 * the same migration when listing all saved accounts.
 */
export function normalizeAccountConfig(raw: AccountConfig): AccountConfig {
  const r = raw as AccountConfig & { algo?: DatabaseAlgorithms };
  if (!r.algos) {
    const algos: Record<string, DatabaseAlgorithms> = r.algo ? { 'nt_msg.db': r.algo } : {};
    return { ...r, algos };
  }
  return r;
}
