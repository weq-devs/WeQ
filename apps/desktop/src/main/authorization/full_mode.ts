import type { LongTermAuthorizationStatus } from '../../shared/long_term_authorization';
import { fullModeAllowed, requestFullMode } from '../context/full_mode';

interface AuthorizationHost {
  account: object | null;
  accountIsStatic: boolean;
  bootstrap: { userConfig: { getSettings(): { autoAttachQq: boolean } } } | null;
  refreshRkeysNow(): Promise<boolean>;
}

/** 仅在助手真实就绪后为当前在线来源请求完整功能，不修改持久偏好。 */
export class AuthorizationFullModeMonitor {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: () => AuthorizationHost,
    private readonly readStatus: () => Promise<LongTermAuthorizationStatus>,
  ) {}

  async check(readStatus = this.readStatus): Promise<LongTermAuthorizationStatus> {
    const host = this.host();
    const source = host.account;
    const status = await readStatus();
    if (
      this.stopped ||
      status.state !== 'ready' ||
      !source ||
      this.host() !== host ||
      host.account !== source ||
      host.accountIsStatic ||
      fullModeAllowed(host, source)
    )
      return status;
    try {
      requestFullMode(host, source);
    } catch {
      // 退出清理期间指针可能尚未替换，失活来源不能被迟到检查重新启用。
      return status;
    }
    // 凭据实际就绪仍由现有监视器判断；助手连接成功不等于在线功能恢复。
    void host.refreshRkeysNow().catch(() => {});
    return status;
  }

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, 0);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    try {
      const host = this.host();
      if (host.account && !host.accountIsStatic && !fullModeAllowed(host)) await this.check();
    } catch {
      // 助手暂不可用时保持原有手动/临时授权路径，下轮重新检查。
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.poll();
        }, 5000);
        this.timer.unref();
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
