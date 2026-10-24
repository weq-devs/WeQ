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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { AnnualReportPreferences } from './annual_report/types';
import type { DatabaseAlgorithms } from '@weq/native';
import { getLogger, logErrorContext } from '../common/logger';
import { writeFileAtomicSync } from '../common/atomic_write';
import { normalizeGroupKeywordRules, type GroupKeywordRules } from './group_keyword';
import type { VipInfo } from './vip';

/**
 * A download rkey issued by QQ's OIDB service (`FetchDownloadRkeys`). Used
 * to authenticate CDN media downloads when a file isn't on disk locally.
 *
 * The `rkey` string already carries its `&rkey=` URL prefix, as QQ returns it.
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
 * A `clientkey` credential issued by QQ's OIDB service (`FetchClientKey`).
 * Short-lived (≈30 min) token used to authenticate web/cgi calls to QQ's
 * services on this account's behalf.
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
  /** 当前账号显式开启的邮箱提醒；不保存邮箱票据。 */
  mailNotifications?: boolean;
  /** 左侧导航显示邮箱未读数；旧配置默认显示。 */
  mailShowUnread?: boolean;
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
   * 静态账号兼容旧记录，使用数据库目录作主键；完整账号根见 backupAccountDir。
   */
  dataDir?: string;
  /** 静态备份的完整账号根；dataDir 保留数据库目录以兼容已有配置 ID 和设置。 */
  backupAccountDir?: string;
  /** Last seen display name / nickname (for the picker). */
  displayName?: string;
  /** Cached avatar URL (for the picker), if resolved. */
  avatarUrl?: string;
  /** Unix milliseconds of last login. */
  lastLoginAt: number;
  /** Per-account annual-report page collection and ordering preferences. */
  annualReport?: AnnualReportPreferences;

  /**
   * 群关键词提醒规则（按账号存）。设为要盯哪些群天然跟账号绑定：同一个群号在 A、
   * B 两个号下是不同的会话，用一份全局规则会互相串。
   *
   * 缺省（`undefined`）= 从未写过（读出来是空表）。升级前存在旧版全局 settings 里的
   * 规则会在启动时一次性搬进各账号记录（见 UserConfigService.migrateGroupKeywordToAccounts）。
   */
  groupKeyword?: GroupKeywordRules;

  /** True while a logged-in QQ.exe instance for this account is running. */
  qqOnline?: boolean;
  /** PID of that running QQ instance, or null when none is online. */
  qqPid?: number | null;
  /**
   * 在线会话的内存物料（a2 / d2 / d2key），只在「自动 attach」开着、账号在线时
   * 采集；账号下线会清掉。**不含 guid** —— guid 是设备标识，见 {@link guid}。
   */
  session?: AccountSessionMaterial;
  /**
   * 设备 guid（32 位小写 hex）。和登录无关（它是设备标识），所以单独一档，放在
   * 账号身份层（紧挨 dataDir / uid），不和会话密钥混在一起 —— 未来它可能来自
   * 别的来源，也不只服务于登录流程。
   */
  guid?: string;
  /**
   * A1 payload（`login.db` 的 `[1004]` 用设备 guid 解密后的内层 TGTGT 结构，
   * hex）。来自 native `decryptLoginDb` 的 `a1Payload`；缺失表示该账号没有可用
   * 的 A1（没缓存 / guid 取不到 / 解密失败）。快速登录时用。
   */
  a1Payload?: string;
  /** Latest download rkeys harvested from the online instance. */
  rkeys?: DownloadRkey[];
  /** Unix ms the rkeys were last refreshed. */
  rkeyUpdatedAt?: number;
  /** Latest clientkey harvested from the online instance (when 自动读取 QQ 内存 is on). */
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
   * p_skey per domain, harvested by the login flow while QQ was still alive.
   * Seeds `WebCredentialProvider` so the first home-dress fetch works without a
   * hook round-trip.
   */
  loginPskey?: Record<string, string>;
  /**
   * 会员身份快照（VIP / SVIP / 大会员 + 年费 + 等级），顶栏徽标用。
   * 在线拿到 vip.qq.com 的 p_skey 时刷新；离线读这份，缺失时再退回本地
   * `profile_info_v6` 的特权清单（见 `account/vip.ts`）。
   */
  vip?: VipInfo;
  /**
   * 上一次**在线确认过**会员身份的时间（unix ms），无论结论是不是会员。
   *
   * 为什么单独一个字段：`vip` 缺失既可能是「还没查过」，也可能是「查过了、
   * 不是会员」。前者该退回本地特权清单，后者不该 —— 否则退会以后本地那份
   * 旧资料会把徽标又顶回来。有这个字段就以它的结论为准。
   */
  vipCheckedAt?: number;
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
    /** 正在用的通话背景静态图（appId 17）。空表示没设。 */
    callBgUrl?: string;
    /** 通话背景的动态版（funCall/.../media.mp4）。有值时优先播视频。 */
    callBgVideoUrl?: string;
    /** 通话背景装扮 itemId。 */
    callBgId?: number;
    /** 通话背景装扮款名。 */
    callBgName?: string;
    /**
     * 上次为「通话背景」这一项查过服务的时刻（毫秒）。
     *
     * 用来区分「确实没设背景」与「老快照里根本没查过这一项」：
     * `callBgUrl` 为空且这里有值 = 查过了、用户没设，通话时不必再查。
     */
    callBgCheckedAt?: number;
  };
}

/** Metadata threaded in from the open flow to enrich the saved record. */
export interface AccountConfigMetadata {
  displayName?: string;
  avatarUrl?: string;
  dataDir?: string;
  backupAccountDir?: string;
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
      ...(metadata.backupAccountDir ? { backupAccountDir: metadata.backupAccountDir } : {}),
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

  setMailNotifications(enabled: boolean): void {
    this.patch({ mailNotifications: enabled });
  }

  setMailShowUnread(enabled: boolean): void {
    this.patch({ mailShowUnread: enabled });
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

  /**
   * 记下刚从在线 QQ 进程内存里读到的会话物料（a2 / d2 / d2key）。传 `null` 表示
   * 账号下线 / 物料作废（旧的密钥留着只会误导）。
   */
  setSessionMaterial(material: Omit<AccountSessionMaterial, 'fetchedAt'> | null): void {
    if (material === null) {
      this.patch({ session: undefined });
      this.logger.info('cleared account session material', {
        event: 'set-session-material',
        cleared: true,
      });
      return;
    }
    this.patch({ session: { ...material, fetchedAt: Date.now() } });
    // 只记「有没有」——物料本身就是凭据，不进日志。
    this.logger.info('stored account session material', {
      event: 'set-session-material',
      hasA2: material.a2 !== undefined,
      hasD2: material.d2 !== undefined,
      hasD2Key: material.d2Key !== undefined,
      pid: material.pid ?? null,
    });
  }

  /**
   * 记下设备 guid（和登录无关的设备标识，单独一档）。重复值不重写。
   */
  setGuid(guid: string): void {
    if (guid.length === 0 || this.readRecord()?.guid === guid) return;
    this.patch({ guid });
    this.logger.info('stored device guid', { event: 'set-guid', guid });
  }

  /**
   * 记下账号的字符串 uid（`u_...`）。linux 的账号目录 `nt_qq_<md5(md5(uid)+"nt_kernel")>`
   * 由它派生，所以它必须落盘 —— 只在内存里映射的话重启就丢。重复值不重写。
   */
  setUid(uid: string): void {
    if (uid.length === 0 || this.readRecord()?.uid === uid) return;
    this.patch({ uid });
    this.logger.info('stored account uid', { event: 'set-uid', uid });
  }

  /**
   * 记下解出来的 A1 payload（`login.db [1004]` 经设备 guid 解密后的内层 TGTGT
   * 结构，hex）。重复值不重写；空串表示没有可用 A1，直接跳过。
   */
  setA1Payload(a1Payload: string): void {
    if (a1Payload.length === 0 || this.readRecord()?.a1Payload === a1Payload) return;
    this.patch({ a1Payload });
    // payload 本身是凭据，只记「有没有」和长度，不进日志原文。
    this.logger.info('stored a1 payload', {
      event: 'set-a1-payload',
      length: a1Payload.length,
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
   * Persist the 会员身份快照（顶栏徽标）。`null` = 在线确认过不是会员，
   * 写空对象把旧值清掉，免得降级后徽标还挂着上一份身份。
   *
   * 同时记下 `vipCheckedAt`：它是「这次结论来自在线接口」的凭据，读取方据此
   * 决定要不要退回本地特权清单（见 {@link AccountConfig.vipCheckedAt}）。
   */
  setVipInfo(vip: VipInfo | null, checkedAt = Date.now()): void {
    this.patch({ vip: vip ?? undefined, vipCheckedAt: checkedAt });
    this.logger.info('stored account vip snapshot', {
      event: 'set-vip',
      tier: vip?.tier ?? null,
      year: vip?.year ?? null,
      level: vip?.level ?? null,
    });
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

  /** 读这个账号的群关键词提醒规则（未配置 = 空表，即不提醒任何群）。 */
  getGroupKeywordRules(): GroupKeywordRules {
    return normalizeGroupKeywordRules(this.readRecord()?.groupKeyword);
  }

  /** 写这个账号的群关键词提醒规则（空表 = 该账号不再提醒任何群）。 */
  setGroupKeywordRules(rules: GroupKeywordRules): void {
    const normalized = normalizeGroupKeywordRules(rules);
    this.patch({ groupKeyword: normalized });
    this.logger.info('stored group keyword rules', {
      event: 'set-group-keyword-rules',
      groupCount: Object.keys(normalized).length,
    });
  }

  /** Persist p_skey harvested during the login flow. */
  setLoginPskey(loginPskey: Record<string, string>): void {
    this.patch({ loginPskey });
    this.logger.info('stored login pskey', {
      event: 'set-login-pskey',
      domains: Object.keys(loginPskey),
    });
  }

  /**
   * Drop one domain's login-harvested p_skey once a cgi has rejected it.
   *
   * 落盘的 seed 票据只该在「还有效」时留着：它会在下次开账号时被重新 seed 进
   * `WebCredentialProvider`，而过期的 seed 会短路掉活 hook 查询（见
   * `credential.ts` 的 `seedPskey` / `invalidate`），结果是每个域每次请求都先白
   * 失败一轮。所以失效即删除，等下次登录再收一份新的。
   */
  clearLoginPskey(domain: string): void {
    const existing = this.readRecord()?.loginPskey;
    if (!existing || !(domain in existing)) return;
    const rest = { ...existing };
    delete rest[domain];
    // 空表就整字段撤掉（`undefined` 会被 JSON.stringify 丢掉），别留个 `{}`。
    this.patch({ loginPskey: Object.keys(rest).length > 0 ? rest : undefined });
    this.logger.info('dropped invalid login pskey', {
      event: 'clear-login-pskey',
      domain,
      remaining: Object.keys(rest),
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
    const filePath = join(this.accountsDir, `${config.configId}.json`);
    try {
      writeFileAtomicSync(filePath, JSON.stringify(config, null, 2));
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
 * 从在线 QQ 进程内存里读到的一次会话物料。三个字段都是 hex 字符串：
 * a2 / d2 为原文 hex，d2Key 为 32 位 hex。任一项没扫到就是 `undefined`。
 *
 * 这里**没有 guid**：guid 与登录无关（它是设备标识），单独存在
 * {@link AccountConfig.guid}。
 */
export interface AccountSessionMaterial {
  a2?: string;
  d2?: string;
  d2Key?: string;
  /**
   * 读到这份物料时 QQ 的 pid。用来判断「这份缓存是不是仍属于当前那个 QQ 进程」
   * —— 本地凭据齐全时直接拿它登记 SSO（不读内存、不提权）；pid 对不上说明 QQ
   * 重启过、旧密钥已随旧进程失效，回退到读内存。
   */
  pid?: number;
  /** Unix ms，最后一次读到的时刻。 */
  fetchedAt: number;
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
