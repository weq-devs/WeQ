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

/** 原生提示的状态独立于 renderer；重载只由用户选择触发。 */
export function createRendererRecovery(options: {
  unavailable(): boolean;
  quitting(): boolean;
  showDialog(): Promise<number>;
  reload(): void;
  quit(): void;
  record(
    event: 'gone' | 'dialog-failed' | 'reload' | 'quit',
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
  const available = () => !disposed && !options.unavailable() && !options.quitting();

  const request = (): void => {
    if (!crashed || pending || !available()) return;
    pending = true;
    const expected = generation;
    void (async () => {
      try {
        const choice = await options.showDialog();
        if (!available() || !crashed || expected !== generation) return;
        if (choice === 0) {
          options.record('reload');
          options.reload();
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
    needsRecovery: () => crashed,
    gone(details: { reason: string; exitCode: number }) {
      if (disposed) return;
      options.record('gone', {
        reason: EXIT_REASONS.has(details.reason) ? details.reason : 'unknown',
        exitCode: details.exitCode,
      });
      if (!crashed) generation += 1;
      crashed = true;
      request();
    },
    loaded() {
      generation += 1;
      crashed = false;
    },
    dispose() {
      disposed = true;
      generation += 1;
    },
  };
}
