import { isUpdateCheckInterval } from '@weq/service/update-settings';

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** 分段等待长间隔，检查完成后再计时，避免慢请求重叠。 */
export class UpdateCheckScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private minutes = -1;
  private running = false;

  constructor(private readonly check: () => Promise<unknown>) {}

  configure(minutes: number, startup = false): void {
    if (!isUpdateCheckInterval(minutes)) throw new Error('更新检查频率须为正数或 -1');
    this.stop();
    this.minutes = minutes;
    if (minutes !== -1 && !this.running) this.wait(startup ? 3000 : minutes * 60_000);
  }

  stop(): void {
    this.revision++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.minutes = -1;
  }

  private wait(remaining: number): void {
    const revision = this.revision;
    const delay = Math.min(remaining, MAX_TIMEOUT_MS);
    this.timer = setTimeout(() => {
      if (revision !== this.revision) return;
      if (remaining > delay) this.wait(remaining - delay);
      else void this.run();
    }, delay);
    this.timer.unref();
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      await this.check();
    } catch {
      // 自动检查失败保持静默，下个周期重试；手动检查仍反馈具体错误。
    } finally {
      this.running = false;
      if (this.minutes !== -1) this.wait(this.minutes * 60_000);
    }
  }
}
