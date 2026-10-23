/**
 * 顶栏会员徽标的数据刷新。
 *
 * 会员身份（VIP / SVIP / 大会员 + 年费 + 等级）只能从 QQ 的 web cgi 拿，鉴权是
 * `vip.qq.com` 域的 p_skey —— 它可能在**任意时刻**才变得可用：
 *
 *   1. 登录流程顺手收下的 p_skey 落盘在 `AccountConfig.loginPskey`，QQ 现在没开
 *      也可能还没过期（WeQ 先启动、QQ 后启动的常见场景）；
 *   2. QQ 上线 / 重启后，AccountMonitor 登记 SSO 会话成功会发
 *      `onlineCredentialsReady`，这时活 hook 才换得出新票；
 *   3. 长期在线期间会员等级/年费可能变化，用一个低频定时器慢慢校正。
 *
 * 三条路都只做一件事：换票 → 查 club.vip → 写 `AccountConfig.vip` → 通知渲染层。
 * 换票与重试的细节在 `@weq/service` 的 `fetchAccountVipInfo` 里，这里只负责时机。
 * 失败一律静默降级（离线且没有 seed 是预期失败），绝不打断开账号流程。
 *
 * 不复用 `services.webQuery`：它的 `resolveOnlinePid` 在离线时会直接抛错，而这里
 * **必须允许 QQ 没开、只用 seed 票据**。
 */

import {
  fetchAccountVipInfo,
  getLogger,
  logErrorContext,
  WebAuthError,
  VIP_PSKEY_DOMAIN,
  type AccountConfigService,
} from '@weq/service';
import type { NtHelperBinding } from '@weq/native';

/** 会员信息变化后通知渲染层（由 ctx 接到 `accountEventBus`）。 */
export type VipChangedHandler = () => void;

/** 在线时的校正间隔：等级/年费变化不频繁，6 小时足够。 */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 两次刷新之间的最小间隔，防止「上线事件 + 定时器」叠在一起来回打接口。 */
const MIN_REFRESH_GAP_MS = 60 * 1000;
/** 失败后的重试间隔（网络抖动 / 票据刚失效）。 */
const RETRY_DELAY_MS = 5 * 60 * 1000;

export class VipBadgeService {
  private readonly logger;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 正在跑的那一轮（同一时刻只允许一个请求在飞）。 */
  private inflight: Promise<void> | null = null;
  /** 上一次真正发请求的时间（unix ms），用于最小间隔。 */
  private lastAttemptAt = 0;
  /** 订阅 onlineCredentialsReady 的清理函数。 */
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly uin: string,
    private readonly nt: Pick<NtHelperBinding, 'ptFetchCredentials'>,
    private readonly accountConfig: AccountConfigService,
    /**
     * 账号级事件总线上的「凭据就绪」订阅；由 ctx 注入，避免本文件 import
     * app_context（那个模块会反向 import 到这里）。
     */
    onCredentialsReady: (handler: () => void) => () => void,
    private readonly onChanged: VipChangedHandler,
  ) {
    this.logger = getLogger().child({ scope: 'vip-badge', accountUin: uin });
    this.unsubscribe = onCredentialsReady(() => {
      void this.refresh('credentials-ready');
    });
  }

  start(): void {
    // 登录时 seed 的 p_skey 可能还没过期 —— 这是「QQ 没开也能出徽标」的那条路。
    void this.refresh('start');
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 刷新一次；最小间隔挡住短时间内重复触发，同一时刻只跑一个。 */
  private refresh(reason: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inflight) return this.inflight;
    if (Date.now() - this.lastAttemptAt < MIN_REFRESH_GAP_MS) return Promise.resolve();

    this.lastAttemptAt = Date.now();
    this.inflight = this.doRefresh(reason).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(reason: string): Promise<void> {
    const record = this.accountConfig.getRecord();
    const seed = record?.loginPskey?.[VIP_PSKEY_DOMAIN];
    const pid = record?.qqOnline && record.qqPid ? record.qqPid : 0;

    // 既没有 seed 票据、也没有在线实例 —— 这一轮没票可用，等下一次时机。
    if (!seed && pid <= 0) {
      this.logger.debug('vip refresh skipped: no credentials', {
        event: 'vip-skip-no-credential',
        reason,
      });
      this.scheduleNext(RETRY_DELAY_MS);
      return;
    }

    let vip: Awaited<ReturnType<typeof fetchAccountVipInfo>>;
    try {
      vip = await fetchAccountVipInfo({
        nt: this.nt,
        uin: this.uin,
        pid,
        seedPskey: seed ? { [VIP_PSKEY_DOMAIN]: seed } : undefined,
        onSeedInvalidated: (domain) => this.accountConfig.clearLoginPskey(domain),
      });
    } catch (error) {
      // 票据被服务端判失效时，落盘那份一并作废：否则下次开账号还会先白失败一轮。
      // `fetchAccountVipInfo` 在离线分支不会触发失效回调（换不出新票），这里补一刀；
      // 在线分支它自己会调，重复删是同值幂等操作。
      if (error instanceof WebAuthError && seed) {
        this.logger.info('dropping stale vip pskey', {
          event: 'vip-seed-invalidated',
          code: error.code ?? null,
        });
        this.accountConfig.clearLoginPskey(VIP_PSKEY_DOMAIN);
      }
      this.logger.warn('vip info fetch failed (non-fatal)', {
        event: 'vip-fetch-failed',
        reason,
        pid,
        hasSeed: Boolean(seed),
        ...logErrorContext(error),
      });
      this.scheduleNext(RETRY_DELAY_MS);
      return;
    }

    if (this.stopped) return;
    this.accountConfig.setVipInfo(vip);
    this.logger.info('refreshed account vip info', {
      event: 'vip-fetched',
      reason,
      pid,
      usedSeedOnly: Boolean(seed) && pid <= 0,
      tier: vip?.tier ?? null,
      year: vip?.year ?? null,
      level: vip?.level ?? null,
    });
    this.onChanged();
    this.scheduleNext(REFRESH_INTERVAL_MS);
  }

  private scheduleNext(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      // 定时器只在有在线实例时才有意义；离线时靠「凭据就绪」事件唤醒。
      const record = this.accountConfig.getRecord();
      if (!record?.qqOnline || !record.qqPid) {
        this.scheduleNext(REFRESH_INTERVAL_MS);
        return;
      }
      void this.refresh('timer');
    }, ms);
  }
}
