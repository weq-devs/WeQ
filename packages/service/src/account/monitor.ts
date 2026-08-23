/**
 * AccountMonitorService — per-account background task that tracks whether a
 * logged-in QQ.exe instance for this account is running, and while it is,
 * injects the hook and harvests download rkeys / clientkey / home-dress
 * snapshot — unless 完全离线模式 (自动注入 QQ) is on, in which case it only
 * tracks online/pid state and never touches the QQ process.
 *
 * Lifecycle (owned by the open/close of an account session):
 *   start() →  poll `resolveQqPid(uin)` until a QQ instance for this account
 *              appears (db-lock probe: who holds the account's nt_msg.db)
 *           →  record { qqOnline: true, qqPid } into the account config
 *           →  inject the hook once + `fetchDownloadRkeys` → store rkeys
 *           →  keep resolving the pid; when the QQ instance disappears, clear
 *              pid + mark offline and fall back to login-polling
 *   stop()  →  ends all polling.
 *
 * All native calls are best-effort: any throw degrades to "treat as offline,
 * retry next tick" rather than tearing the loop down. Uses a single chained
 * `setTimeout` (guarded by `running`) so only one timer is ever live.
 */

import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import type { AccountConfigService, DownloadRkey, ClientKey } from './user_config';
import { rkeyExpiryMs, clientKeyExpiryMs } from './user_config';
import { createDirectInjectHook, type InjectHook } from '../bootstrap/inject';
import { fetchHomeDress, type HomeDressSnapshot } from './home_dress';
import { getLogger, logErrorContext } from '../common/logger';

/** How often to poll for the account becoming logged in. */
const LOGIN_POLL_MS = 5000;
/** How often to poll the attached pid for liveness. */
const PID_POLL_MS = 5000;
/** Refresh rkeys this long before they expire. */
const RKEY_REFRESH_SKEW_MS = 5 * 60 * 1000;
/** Refresh clientkey this long before it expires. */
const CLIENTKEY_REFRESH_SKEW_MS = 5 * 60 * 1000;

export class AccountMonitorService {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The pid we currently believe hosts this account, or null. */
  private attachedPid: number | null = null;
  /** Last online state written to config — avoids rewriting it every tick. */
  private lastOnline: boolean | null = null;
  private lastPid: number | null | undefined = undefined;
  /** onHomeDress 已经调过了 —— 每个会话只同步一次装扮,见构造参数说明。 */
  private homeDressSynced = false;
  private readonly logger;

  /**
   * @param shouldAutoInject Checked live before each injection — when it
   *   returns false (用户关掉了「自动注入 QQ」, 完全离线模式), online/pid
   *   tracking keeps running but hook injection AND all harvesting
   *   (rkey / clientkey / 首页装扮快照) are skipped. Defaults to always-on.
   * @param injectHook Turns a pid into a sendable-state before harvesting.
   *   Defaults to the in-process direct inject (win32). On linux the desktop
   *   app passes a pkexec-elevated hook. A single shared instance across all
   *   monitors keeps its own per-pid idempotency, so switching accounts never
   *   re-injects the same QQ.
   * @param onHomeDress 抓到装扮快照后调一次。给装扮同步用(把手机 QQ 正在用的
   *   气泡/字体装上)——**只在本次会话第一次 harvest 时触发**,后续轮询不再调,
   *   否则会反复覆盖用户在装扮页里的选择。
   */
  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
    private readonly accountConfig: AccountConfigService,
    private readonly shouldAutoInject: () => boolean = () => true,
    private readonly injectHook: InjectHook = createDirectInjectHook(platform.native.ntHelper),
    private readonly onHomeDress?: (dress: HomeDressSnapshot) => Promise<void>,
  ) {
    this.logger = getLogger().child({
      scope: 'account-monitor',
      accountUin: this.session.context.uin,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info('started account monitor', { event: 'monitor-start' });
    this.scheduleLoginPoll(0);
  }

  /**
   * Force a one-shot rkey harvest right now, ignoring the background gate — the
   * explicit "立即重新获取 rkey" before a media-completing export. Resolves the
   * QQ pid fresh if we aren't currently attached. Returns true when fresh rkeys
   * were stored. Best-effort: any failure resolves false rather than throwing.
   */
  async harvestRkeysNow(): Promise<boolean> {
    if (!this.shouldAutoInject()) return false;
    const pid = this.attachedPid ?? this.resolvePid();
    if (pid === null) return false;
    try {
      await this.ensureInjected(pid);
      const raw = await this.nt.fetchDownloadRkeys(pid);
      const rkeys = parseRkeys(raw);
      if (rkeys.length === 0) return false;
      this.accountConfig.setRkeys(rkeys);
      this.logger.info('harvested rkeys on demand', {
        event: 'harvest-rkeys-now',
        pid,
        count: rkeys.length,
      });
      return true;
    } catch (error) {
      this.logger.warn('failed to harvest rkeys on demand', {
        event: 'harvest-rkeys-now-failed',
        pid,
        ...logErrorContext(error),
      });
      return false;
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.attachedPid = null;
    this.lastOnline = null;
    this.lastPid = undefined;
    this.homeDressSynced = false;
    this.logger.info('stopped account monitor', { event: 'monitor-stop' });
  }

  private get uin(): string {
    return this.session.context.uin;
  }

  private get nt(): Platform['native']['ntHelper'] {
    return this.platform.native.ntHelper;
  }

  private schedule(fn: () => void | Promise<void>, ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      if (this.running) void fn();
    }, ms);
  }

  private scheduleLoginPoll(ms: number): void {
    this.schedule(() => this.loginPoll(), ms);
  }

  private schedulePidPoll(ms: number): void {
    this.schedule(() => this.pidPoll(), ms);
  }

  // ---- login phase: wait for the account to come online -------------------

  private async loginPoll(): Promise<void> {
    const pid = this.resolvePid();
    if (pid === null) {
      this.markOffline();
      return this.scheduleLoginPoll(LOGIN_POLL_MS);
    }

    this.attachedPid = pid;
    this.markOnline(pid);
    this.logger.info('account detected online', { event: 'account-online', pid });
    await this.harvest(pid);
    this.schedulePidPoll(PID_POLL_MS);
  }

  /**
   * Attribute one running QQ instance to this account via its `nt_msg.db`
   * file lock (win32 Restart Manager / linux fcntl, QQ-name filtered by the
   * platform) — one probe that both proves the account is signed in and
   * yields the exact pid. A successful probe with no QQ holder means the
   * account is offline. The port probe is only reached when the db-lock probe
   * itself could not run or errored (e.g. permission denied). Null means "no
   * QQ instance for this account right now".
   */
  private resolvePid(): number | null {
    try {
      return this.platform.resolveQqPid(this.uin);
    } catch {
      return null;
    }
  }

  // ---- attached phase: watch the pid, keep rkeys fresh --------------------

  private async pidPoll(): Promise<void> {
    const attached = this.attachedPid;
    if (attached === null) {
      return this.scheduleLoginPoll(LOGIN_POLL_MS);
    }

    const pid = this.resolvePid();
    if (pid === null) {
      this.injectHook.reset(attached);
      this.logger.info('attached qq process exited; marking account offline', {
        event: 'account-offline',
        pid: attached,
      });
      this.attachedPid = null;
      this.markOffline();
      return this.scheduleLoginPoll(LOGIN_POLL_MS);
    }

    if (pid !== attached) {
      // The account's QQ instance restarted under a new pid — re-attach.
      this.injectHook.reset(attached);
      this.attachedPid = pid;
    }

    await this.harvestIfStale(pid);
    this.schedulePidPoll(PID_POLL_MS);
  }

  // ---- config writes ------------------------------------------------------

  private markOnline(pid: number): void {
    this.writeOnline(true, pid);
  }

  private markOffline(): void {
    this.writeOnline(false, null);
  }

  /** Persist online state only when it actually changed since last write. */
  private writeOnline(online: boolean, pid: number | null): void {
    if (this.lastOnline === online && this.lastPid === pid) return;
    this.lastOnline = online;
    this.lastPid = pid;
    try {
      this.accountConfig.setOnline(online, pid);
    } catch {
      /* config write failed — non-fatal */
    }
  }

  // ---- rkey / clientkey harvesting ----------------------------------------

  private async ensureInjected(pid: number): Promise<void> {
    await this.injectHook.ensure(pid, this.uin);
  }

  /**
   * Inject + harvest rkey / clientkey / 首页装扮快照. 完全离线模式（自动注入
   * QQ 关闭）下整体跳过——不注入、不采集任何凭证。
   */
  private async harvest(pid: number): Promise<void> {
    if (!this.shouldAutoInject()) return;
    try {
      await this.ensureInjected(pid);
      const raw = await this.nt.fetchDownloadRkeys(pid);
      const rkeys = parseRkeys(raw);
      if (rkeys.length > 0) this.accountConfig.setRkeys(rkeys);
      if (rkeys.length > 0) {
        this.logger.info('harvested download rkeys', {
          event: 'harvest-rkeys',
          pid,
          count: rkeys.length,
        });
      }
      const rawCk = await this.nt.fetchClientKey(pid);
      const key = parseClientKey(rawCk);
      if (key) this.accountConfig.setClientKey(key);
      if (key) {
        this.logger.info('harvested client key', {
          event: 'harvest-client-key',
          pid,
          ttlSeconds: key.ttlSeconds,
        });
      }
      // 首页装扮快照：并发抓取，不阻塞 rkey/clientkey 主流程，失败静默降级。
      void fetchHomeDress(this.nt, this.session, pid, this.accountConfig.getRecord()?.loginPskey)
        .then(async (dress) => {
          this.accountConfig.setHomeDress(dress);
          // 只在本次会话第一次成功抓到时回调 —— 装扮同步会写清单，轮询触发的话
          // 会反复覆盖用户在装扮页里的选择。
          if (!this.homeDressSynced) {
            this.homeDressSynced = true;
            await this.onHomeDress?.(dress);
          }
        })
        .catch((e) => {
          this.logger.warn('home dress fetch failed (non-fatal)', {
            event: 'home-dress-fetch-failed',
            pid,
            ...logErrorContext(e),
          });
        });
    } catch (error) {
      this.logger.warn('background harvest failed', {
        event: 'harvest-failed',
        pid,
        ...logErrorContext(error),
      });
      /* leave stale credentials in place; retry on the next stale check */
    }
  }

  /** Refresh rkey/clientkey when they're stale. 完全离线模式下不采集。 */
  private async harvestIfStale(pid: number): Promise<void> {
    if (!this.shouldAutoInject()) return;
    const rec = this.accountConfig.getRecord();
    const now = Date.now();
    const rkeys = rec?.rkeys ?? [];
    const rkeyStale =
      rkeys.length === 0 || rkeys.some((r) => rkeyExpiryMs(r) - now < RKEY_REFRESH_SKEW_MS);
    const ck = rec?.clientKey;
    const ckStale = !ck || clientKeyExpiryMs(ck) - now < CLIENTKEY_REFRESH_SKEW_MS;
    if (rkeyStale || ckStale) await this.harvest(pid);
  }
}

/**
 * Normalise the native `fetchDownloadRkeys` JSON into {@link DownloadRkey}s.
 * Filters out video (12/22) and voice (14/24) rkeys — they're not used and
 * clutter the account-config record.
 */
function parseRkeys(raw: string): DownloadRkey[] {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: DownloadRkey[] = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    if (typeof o.rkey !== 'string') continue;
    const type = typeof o.type_ === 'number' ? o.type_ : 0;
    // Only keep image rkeys (10/20); drop video (12/22) & voice (14/24).
    if (type !== 10 && type !== 20) continue;
    out.push({
      rkey: o.rkey,
      type,
      ttlSeconds: typeof o.ttl_seconds === 'number' ? o.ttl_seconds : 0,
      createTime: typeof o.create_time === 'number' ? o.create_time : 0,
    });
  }
  return out;
}

/** Normalise the native `fetchClientKey` JSON into {@link ClientKey}. */
function parseClientKey(raw: string): ClientKey | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.client_key !== 'string' || !o.client_key) return null;
  return {
    clientKey: o.client_key,
    keyIndex: typeof o.key_index === 'string' ? o.key_index : '',
    ttlSeconds: typeof o.expire_time === 'string' ? parseInt(o.expire_time, 10) || 0 : 0,
    fetchedAt: Date.now(),
  };
}
