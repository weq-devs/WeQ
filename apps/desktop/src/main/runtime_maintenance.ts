import { EventEmitter } from 'node:events';

/** 维护期间拒绝新业务请求，等待已进入的请求结束后再替换文件。 */
export class RuntimeMaintenance {
  private active = 0;
  private idle: (() => void) | null = null;
  private busy = false;
  private revision = 0;
  private error: string | undefined;
  readonly events = new EventEmitter();

  status() {
    return {
      state: this.busy ? 'maintenance' : 'ready',
      revision: this.revision,
      ...(this.error ? { error: this.error } : {}),
    } as const;
  }

  async operation<T>(run: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('WeQ 正在维护中，请稍后重试');
    this.active++;
    try {
      return await run();
    } finally {
      if (--this.active === 0) this.idle?.();
    }
  }

  async run<T>(run: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('已有维护操作正在进行，请稍后重试');
    this.busy = true;
    try {
      if (this.active) await new Promise<void>((resolve) => (this.idle = resolve));
      return await run();
    } finally {
      this.idle = null;
      this.busy = false;
    }
  }

  refreshClients(error?: string): void {
    this.error = error;
    this.revision++;
    // 先让发起恢复的请求返回，再通知所有窗口和 Web 客户端加载新配置。
    setTimeout(() => this.events.emit('changed', this.status()), 100).unref();
  }
}

export const runtimeMaintenance = new RuntimeMaintenance();
export const maintenanceProcedures = new Set([
  'backupStage',
  'backupDefaults',
  'backupApply',
  'clearStorageData',
]);
