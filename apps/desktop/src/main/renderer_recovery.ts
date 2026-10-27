const EXIT_REASONS = new Set([
  'clean-exit',
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
  'memory-eviction',
]);

export function normalizeRendererExitReason(reason: string): string {
  return EXIT_REASONS.has(reason) ? reason : 'unknown';
}

export const RENDERER_AUTO_RELOAD_DELAY_MS = 1000;
export const RENDERER_AUTO_RELOAD_COOLDOWN_MS = 10 * 60_000;
export const RENDERER_RELOAD_TIMEOUT_MS = 15_000;
const AUTOMATIC_REASONS = new Set(['crashed', 'oom', 'abnormal-exit', 'memory-eviction']);

/** 自动恢复有冷却与超时；失败后保留独立于 renderer 的原生入口。 */
export function createRendererRecovery(options: {
  automatic?: boolean;
  now?(): number;
  unavailable(): boolean;
  quitting(): boolean;
  showDialog(): Promise<number>;
  reload(): void;
  quit(): void;
  record(
    event: 'gone' | 'dialog-failed' | 'reload' | 'quit' | 'auto-reload' | 'reload-failed',
    details?: {
      reason: string;
      exitCode: number;
    },
  ): void;
}) {
  let crashed = false;
  let disposed = false;
  let pending = false;
  let generation = 0;
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  let loading = false;
  let lastAutomaticReload: number | null = null;
  const now = options.now ?? (() => performance.now());
  const available = () => !disposed && !options.unavailable() && !options.quitting();
  const clearTimers = () => {
    clearTimeout(autoTimer);
    clearTimeout(loadTimer);
    autoTimer = loadTimer = undefined;
    loading = false;
  };
  const failed = () => {
    if (!loading || !crashed || !available()) return;
    clearTimers();
    options.record('reload-failed');
    queueMicrotask(request);
  };
  const reload = (automatic: boolean) => {
    if (!crashed || !available()) return;
    clearTimers();
    if (automatic) lastAutomaticReload = now();
    options.record(automatic ? 'auto-reload' : 'reload');
    loading = true;
    loadTimer = setTimeout(failed, RENDERER_RELOAD_TIMEOUT_MS);
    loadTimer.unref?.();
    try {
      options.reload();
    } catch {
      failed();
    }
  };

  const request = (): void => {
    if (!crashed || pending || !available()) return;
    clearTimers();
    pending = true;
    const expected = generation;
    void (async () => {
      try {
        const choice = await options.showDialog();
        if (!available() || !crashed || expected !== generation) return;
        if (choice === 0) {
          reload(false);
        } else if (choice === 1) {
          options.record('quit');
          options.quit();
        }
      } catch {
        if (available()) options.record('dialog-failed');
      } finally {
        pending = false;
        if (crashed && expected !== generation && available()) request();
      }
    })();
  };

  return {
    request,
    failed,
    needsRecovery: () => crashed,
    gone(details: { reason: string; exitCode: number }) {
      if (disposed) return;
      options.record('gone', {
        reason: normalizeRendererExitReason(details.reason),
        exitCode: details.exitCode,
      });
      // 同一退出重复到达时不消耗恢复额度，也不抢占已经打开的提示。
      if (crashed && !loading) return;
      const failedWhileLoading = loading;
      clearTimers();
      generation += 1;
      crashed = true;
      if (
        options.automatic &&
        !failedWhileLoading &&
        AUTOMATIC_REASONS.has(details.reason) &&
        available() &&
        (lastAutomaticReload === null ||
          now() - lastAutomaticReload >= RENDERER_AUTO_RELOAD_COOLDOWN_MS)
      ) {
        const expected = generation;
        autoTimer = setTimeout(() => {
          autoTimer = undefined;
          if (expected === generation) reload(true);
        }, RENDERER_AUTO_RELOAD_DELAY_MS);
        autoTimer.unref?.();
      } else request();
    },
    loaded() {
      clearTimers();
      generation += 1;
      crashed = false;
    },
    dispose() {
      clearTimers();
      disposed = true;
      generation += 1;
    },
  };
}
