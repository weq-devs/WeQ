/**
 * AccountMonitorService — per-account background task that tracks whether a
 * logged-in QQ.exe instance for this account is running, and while it is,
 * attaches to it (reads its memory for the session material) and harvests
 * download rkeys / clientkey / home-dress snapshot — unless 完全离线模式
 * (自动 attach QQ) is on, in which case it only tracks online/pid state and
 * never touches the QQ process.
 *
 * Lifecycle (owned by the open/close of an account session):
 *   start() →  poll `resolveQqPid(uin)` until a QQ instance for this account
 *              appears (db-lock probe: who holds the account's nt_msg.db)
 *           →  record { qqOnline: true, qqPid } into the account config
 *           →  attach once (scan a2 / d2 / d2key) + fetch rkeys / clientKey
 *              → store them
 *           →  keep resolving the pid; when the QQ instance disappears, clear
 *              pid + mark offline and fall back to login-polling
 *   stop()  →  ends all polling.
 *
 * All native calls are best-effort: any throw degrades to "treat as offline,
 * retry next tick" rather than tearing the loop down. Uses a single chained
 * `setTimeout` (guarded by `running`) so only one timer is ever live.
 */

import type { AccountSession } from '@weq/account';
import type { SessionMaterial } from '@weq/native';
import type { Platform } from '@weq/platform';
import type { AccountConfigService, DownloadRkey } from './user_config';
import { rkeyExpiryMs, clientKeyExpiryMs } from './user_config';
import { createDirectAttachHook, type AttachHook } from '../bootstrap/attach';
import { fetchHomeDress, type HomeDressSnapshot } from './home_dress';
import { fetchClientKey, fetchDownloadRkeys } from './online_ticket';
import { getLogger, logErrorContext } from '../common/logger';

/** PC 端 `subAppId`（抓包实测值，注册包里它也出现）。 */
const PC_SUB_APP_ID = 537391664;
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
   * @param shouldAutoAttach Checked live before each attach — when it
   *   returns false (用户关掉了「自动 attach QQ」, 完全离线模式), online/pid
   *   tracking keeps running but memory reading AND all harvesting
   *   (rkey / clientkey / 首页装扮快照) are skipped. Defaults to always-on.
   * @param attachHook Reads the session material out of a running QQ pid.
   *   Defaults to the in-process reader (win32). On linux/macOS the desktop app
   *   passes a sudo-elevated hook. A single shared instance across all monitors
   *   keeps its own per-pid idempotency, so switching accounts never re-reads
   *   the same QQ.
   * @param onHomeDress 抓到装扮快照后调一次。给装扮同步用(把手机 QQ 正在用的
   *   气泡/字体装上)——**只在本次会话第一次 harvest 时触发**,后续轮询不再调,
   *   否则会反复覆盖用户在装扮页里的选择。
   */
  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
    private readonly accountConfig: AccountConfigService,
    private readonly shouldAutoAttach: () => boolean = () => true,
    private readonly attachHook: AttachHook = createDirectAttachHook(platform.native.ntHelper),
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
    // 发包序号（sequence）的起点：一次账号会话重置一次。QQ 本体也在推进同一账户的
    // 序号带，所以不能沿用上次会话残留的值，得重新取「now + 扰动」。
    try {
      const start = this.nt.resetPacketSequence();
      this.logger.info('reset packet sequence start point', {
        event: 'reset-packet-sequence',
        start,
      });
    } catch (error) {
      this.logger.warn('failed to reset packet sequence (non-fatal)', {
        event: 'reset-packet-sequence-failed',
        ...logErrorContext(error),
      });
    }
    // 设备 guid 每次开会话读一次就够：它从 QQ 数据根路径离线算/读（不需权限、
    // 不碰进程），且大概率不变 —— 但网络上偶尔会变，所以每次启动都刷新一次。
    this.refreshDeviceGuid();
    this.scheduleLoginPoll(0);
  }

  /**
   * 从 QQ 数据根路径离线算/读设备 guid，更新账号身份层（失败静默降级）。
   *
   * 这一步和「有没有在线 QQ」无关：数据文件在磁盘上就能读，所以完全离线模式
   * （自动 attach 关闭）也照做。
   */
  private refreshDeviceGuid(): void {
    try {
      const root = this.platform.qqDataRoot();
      if (!root) return;
      const guid = this.nt.readDeviceGuid(root);
      if (guid) this.accountConfig.setGuid(guid);
    } catch (error) {
      this.logger.warn('failed to read device guid (non-fatal)', {
        event: 'read-device-guid-failed',
        ...logErrorContext(error),
      });
    }
  }

  /**
   * Force a one-shot rkey harvest right now, ignoring the background gate — the
   * explicit "立即重新获取 rkey" before a media-completing export. Resolves the
   * QQ pid fresh if we aren't currently attached. Returns true when fresh rkeys
   * were stored. Best-effort: any failure resolves false rather than throwing.
   */
  async harvestRkeysNow(): Promise<boolean> {
    if (!this.shouldAutoAttach()) return false;
    const pid = this.attachedPid ?? this.resolvePid();
    if (pid === null) return false;
    try {
      await this.ensureAttached(pid);
      const rkeys = imageRkeys(await fetchDownloadRkeys(this.nt, pid));
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
    // 会话结束：物料与可能存在的原生连接都不该留着。
    if (this.attachedPid !== null) this.forgetSsoSession(this.attachedPid);
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
   * platform) — the one probe that both proves the account is signed in and
   * yields the exact pid. A successful probe with no QQ holder means the
   * account is offline. Null means "no QQ instance for this account right now".
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
      this.attachHook.reset(attached);
      this.forgetSsoSession(attached);
      this.logger.info('attached qq process exited; marking account offline', {
        event: 'account-offline',
        pid: attached,
      });
      this.attachedPid = null;
      this.markOffline();
      return this.scheduleLoginPoll(LOGIN_POLL_MS);
    }

    if (pid !== attached) {
      // The account's QQ instance restarted under a new pid — re-attach, and
      // move the session material onto the new pid (the old pid's credentials
      // died with the old QQ process).
      this.attachHook.reset(attached);
      this.forgetSsoSession(attached);
      this.attachedPid = pid;
      if (this.shouldAutoAttach()) {
        try {
          await this.ensureAttached(pid);
        } catch (error) {
          this.logger.warn('re-attach after pid change failed (non-fatal)', {
            event: 'reattach-failed',
            pid,
            ...logErrorContext(error),
          });
        }
      }
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
      // 账号下线，上一轮的会话密钥就作废了（pid 复用 / 换账号都会让它们失效）。
      // 设备 guid 不在这里清 —— 它是设备标识，和登录无关。
      if (!online) this.accountConfig.setSessionMaterial(null);
    } catch {
      /* config write failed — non-fatal */
    }
  }

  // ---- rkey / clientkey harvesting ----------------------------------------

  /**
   * Attach 到 `pid` 并把读到的会话物料（a2 / d2 / d2key）写进账号配置的
   * 「在线会话」那一块，然后交给原生侧（见 {@link storeSsoSession}）。
   * 设备 guid 不在这里 —— 它从数据根路径离线读（见 {@link refreshDeviceGuid}），
   * 与登录无关。
   */
  private async ensureAttached(pid: number): Promise<void> {
    const material = await this.attachHook.ensure(pid, this.uin);
    this.accountConfig.setSessionMaterial({
      a2: material.a2,
      d2: material.d2,
      d2Key: material.d2Key,
    });
    await this.storeSsoSession(pid, material);
  }

  /**
   * 把会话物料交给原生侧（`setSsoSession`）：之后 `@weq/protocol` 的每个 `sendOidb` /
   * `sendPacket` 都能用同一个 pid 借这些凭据直接发包。
   *
   * **只存物料、不建连、也不上线**：TCP 等到真要发包时才连，在线状态与心跳全交给同机
   * 跑着的 QQ 本体（再注册一次会让服务端看到同设备同 d2 的第二个客户端）。
   *
   * 这是采集到的 a2/d2/d2key 与离线读到的 guid/uid 的**消费方**。物料不齐时不存
   * （缺 guid 时服务端不认这台设备）；QQ 数据根还没解析出来时下一轮 poll 会再试。
   * 失败按「本轮不存」处理（缓存物料还在，重试会再走一次）。
   */
  private async storeSsoSession(pid: number, material: SessionMaterial): Promise<void> {
    const record = this.accountConfig.getRecord();
    const uid = record?.uid;
    const guid = record?.guid;
    if (!material.a2 || !material.d2 || !material.d2Key || !uid || !guid) {
      // 只报「有没有」——物料本身就是凭据，不进日志。
      this.logger.warn('session material incomplete; native transport not configured', {
        event: 'set-sso-session-skipped',
        pid,
        hasA2: material.a2 !== undefined,
        hasD2: material.d2 !== undefined,
        hasD2Key: material.d2Key !== undefined,
        hasUid: uid !== undefined,
        hasGuid: guid !== undefined,
      });
      return;
    }
    try {
      await this.nt.setSsoSession(
        pid,
        {
          uin: this.uin,
          a2: Buffer.from(material.a2, 'hex'),
          d2: Buffer.from(material.d2, 'hex'),
          d2Key: Buffer.from(material.d2Key, 'hex'),
          guid,
          uid,
          subAppId: PC_SUB_APP_ID,
        },
        this.platform.qqWrapperNodePath(),
      );
      this.logger.info('stored session material for the native sso transport', {
        event: 'set-sso-session',
        pid,
        uin: this.uin,
      });
    } catch (error) {
      this.logger.warn('failed to store session material for the native transport (non-fatal)', {
        event: 'set-sso-session-failed',
        pid,
        ...logErrorContext(error),
      });
    }
  }

  /** 丢掉 `pid` 的会话物料（QQ 重启 / 账号下线），顺带关掉可能存在的连接。 */
  private forgetSsoSession(pid: number): void {
    void this.nt.clearSsoSession(pid).catch((error) => {
      this.logger.warn('failed to clear the native sso session (non-fatal)', {
        event: 'clear-sso-session-failed',
        pid,
        ...logErrorContext(error),
      });
    });
  }

  /**
   * Attach + harvest rkey / clientkey / 首页装扮快照. 完全离线模式（自动
   * attach QQ 关闭）下整体跳过 —— 不读内存、不采集任何凭证。
   */
  private async harvest(pid: number): Promise<void> {
    if (!this.shouldAutoAttach()) return;
    try {
      await this.ensureAttached(pid);
      const rkeys = imageRkeys(await fetchDownloadRkeys(this.nt, pid));
      if (rkeys.length > 0) this.accountConfig.setRkeys(rkeys);
      if (rkeys.length > 0) {
        this.logger.info('harvested download rkeys', {
          event: 'harvest-rkeys',
          pid,
          count: rkeys.length,
        });
      }
      const key = await fetchClientKey(this.nt, pid);
      this.accountConfig.setClientKey({ ...key, fetchedAt: Date.now() });
      this.logger.info('harvested client key', {
        event: 'harvest-client-key',
        pid,
        ttlSeconds: key.ttlSeconds,
      });
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
    if (!this.shouldAutoAttach()) return;
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

/** Keep only image rkeys (10/20); drop anything else the server may return. */
function imageRkeys(rkeys: DownloadRkey[]): DownloadRkey[] {
  return rkeys.filter((r) => r.type === 10 || r.type === 20);
}
