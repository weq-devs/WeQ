import type { DatabaseMaintenanceSnapshot } from '@weq/service';

/** 原生窗口关闭要先完成放弃操作；修复开始后，窗口不再拥有任务的生命周期。 */
export function guardDatabaseMaintenanceWindow(
  window: {
    on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
    close(): void;
  },
  options: {
    quitting(): boolean;
    current(): DatabaseMaintenanceSnapshot | null;
    confirmEnd(): Promise<boolean>;
    end(snapshot: DatabaseMaintenanceSnapshot): Promise<void>;
    failed(error: unknown): void;
  },
): void {
  let allowed = false;
  let deciding = false;
  window.on('close', (event) => {
    const snapshot = options.current();
    if (
      allowed ||
      options.quitting() ||
      !snapshot ||
      snapshot.state === 'ended' ||
      snapshot.state === 'repairing'
    )
      return;
    event.preventDefault();
    if (deciding) return;
    deciding = true;
    void (async () => {
      try {
        if (snapshot.state !== 'ending' && !(await options.confirmEnd())) return;
        const latest = options.current();
        if (latest && latest.state !== 'repairing' && latest.state !== 'ended')
          await options.end(latest);
        allowed = true;
        window.close();
      } catch (error) {
        options.failed(error);
      } finally {
        deciding = false;
      }
    })();
  });
}

export function guardDatabaseMaintenanceQuit(
  app: {
    on(
      event: 'before-quit',
      listener: (event: { readonly defaultPrevented?: boolean; preventDefault(): void }) => void,
    ): unknown;
    quit(): void;
  },
  options: {
    repairing(): boolean;
    confirmStop(): Promise<boolean>;
    stop(): Promise<void>;
    cancelled(): void;
    failed(error: unknown): void;
  },
): void {
  let deciding = false;
  app.on('before-quit', (event) => {
    if (event.defaultPrevented || !options.repairing()) return;
    event.preventDefault();
    if (deciding) return;
    deciding = true;
    void (async () => {
      try {
        if (!(await options.confirmStop())) {
          options.cancelled();
          return;
        }
        await options.stop();
        app.quit();
      } catch (error) {
        options.cancelled();
        options.failed(error);
      } finally {
        deciding = false;
      }
    })();
  });
}
