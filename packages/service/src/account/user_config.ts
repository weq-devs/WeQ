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
}

/** Absolute expiry of an rkey in unix milliseconds. */
export function rkeyExpiryMs(r: DownloadRkey): number {
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
   * SQLCipher key. Empty string for already-decrypted static accounts that
   * opened without a key (the record is always written with at least '').
   */
  dbKey: string;
  /**
   * Cryptographic algorithms used for this account's databases. Empty
   * strings for plain (already-decrypted) static accounts.
   */
  algo: DatabaseAlgorithms;
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

  /** True while a logged-in QQ.exe instance for this account is running. */
  qqOnline?: boolean;
  /** PID of that running QQ instance, or null when none is online. */
  qqPid?: number | null;
  /** Latest download rkeys harvested from the online instance. */
  rkeys?: DownloadRkey[];
  /** Unix ms the rkeys were last refreshed. */
  rkeyUpdatedAt?: number;
  /** Latest clientkey harvested from the online instance (when 自动获取 ClientKey is on). */
  clientKey?: ClientKey;
  /**
   * True for static / offline accounts opened from a directory of
   * already-decrypted (or SQLCipher-keyed) databases. Drives the
   * 「静态」 badge in the account list and chooses `setStaticAccount`
   * vs `setAccount` on re-open.
   */
  static?: boolean;
}

/** Metadata threaded in from the open flow to enrich the saved record. */
export interface AccountConfigMetadata {
  displayName?: string;
  avatarUrl?: string;
  dataDir?: string;
  /** Set when opening a static (offline) account so the badge / re-open
   *  path know which flow to use. */
  static?: boolean;
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
    this.logger = getLogger().child({ scope: 'account-config', accountUin: this.session.context.uin });
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
      algo: this.session.context.algo,
      ...(metadata.dataDir ? { dataDir: metadata.dataDir } : {}),
      ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
      ...(metadata.avatarUrl ? { avatarUrl: metadata.avatarUrl } : {}),
      ...(metadata.static === true ? { static: true } : {}),
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

  private patch(partial: Partial<AccountConfig>): void {
    const existing = this.readRecord();
    if (!existing) return; // save() seeds the record before any patch
    this.writeRecord({ ...existing, ...partial });
  }

  private readRecord(): AccountConfig | null {
    const filePath = join(this.accountsDir, `${this.currentConfigId}.json`);
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as AccountConfig;
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
