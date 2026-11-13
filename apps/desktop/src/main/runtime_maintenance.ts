import { EventEmitter } from 'node:events';
import { OperationError } from '@weq/service';

export const MAINTENANCE_DRAIN_TIMEOUT_MS = 15_000;

/** 维护期间拒绝新业务请求，等待已进入的请求结束后再替换文件。 */
export class RuntimeMaintenance {
  private active = new Map<symbol, string>();
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

  async operation<T>(run: () => Promise<T>, name = '后台请求'): Promise<T> {
    if (this.busy) throw new OperationError('WeQ 正在维护中，请稍后重试', 'expected');
    const id = Symbol();
    this.active.set(id, name);
    try {
      return await run();
    } finally {
      this.active.delete(id);
      if (this.active.size === 0) this.idle?.();
    }
  }

  async run<T>(run: () => Promise<T>): Promise<T> {
    if (this.busy) throw new OperationError('已有维护操作正在进行，请稍后重试', 'expected');
    this.busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.active.size)
        await new Promise<void>((resolve, reject) => {
          this.idle = resolve;
          timer = setTimeout(() => {
            const names = [...new Set(this.active.values())];
            reject(
              new Error(
                `等待已有请求结束超时：${names.slice(0, 5).join('、')}${names.length > 5 ? '等' : ''}。本次操作未修改配置或数据，请等待相关任务结束后重试。`,
              ),
            );
          }, MAINTENANCE_DRAIN_TIMEOUT_MS);
        });
      if (timer) clearTimeout(timer);
      return await run();
    } finally {
      if (timer) clearTimeout(timer);
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
  'startup.snapshot',
  'backupStage',
  'backupDefaults',
  'backupApply',
  'clearStorageData',
]);
