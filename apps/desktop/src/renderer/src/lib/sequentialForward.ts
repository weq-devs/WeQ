export interface ForwardOptions {
  mode: 'fixed' | 'text';
  intervalMs: number;
  msPerCharacter: number;
  jitterMs: number;
  maxAttempts: number;
  failure: 'skip' | 'abort';
}
export const DEFAULT_FORWARD_OPTIONS: ForwardOptions = {
  mode: 'fixed',
  intervalMs: 0,
  msPerCharacter: 80,
  jitterMs: 0,
  maxAttempts: 1,
  failure: 'abort',
};
export function forwardDelay(text: string, options: ForwardOptions, random = Math.random): number {
  const base =
    options.mode === 'text' ? Array.from(text).length * options.msPerCharacter : options.intervalMs;
  return Math.max(0, Math.round(base + (random() * 2 - 1) * options.jitterMs));
}
export async function forwardSequentially<T>(
  rows: readonly T[],
  options: ForwardOptions,
  deps: {
    send: (row: T, index: number, attempt: number) => Promise<void>;
    text: (row: T) => string;
    signal: AbortSignal;
    progress: (index: number, attempt: number, state: 'sending' | 'sent' | 'failed') => void;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<{ sent: number; failed: number }> {
  if (
    !Number.isInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    options.maxAttempts > 20 ||
    [options.intervalMs, options.msPerCharacter, options.jitterMs].some(
      (value) => !Number.isFinite(value) || value < 0 || value > 3_600_000,
    )
  )
    throw new Error('转发参数无效');
  let sent = 0,
    failed = 0;
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve, reject) => {
        deps.signal.throwIfAborted();
        const abort = () => {
          clearTimeout(timer);
          reject(new Error('已停止转发'));
        };
        const timer = setTimeout(() => {
          deps.signal.removeEventListener('abort', abort);
          resolve();
        }, ms);
        deps.signal.addEventListener('abort', abort, { once: true });
      }));
  for (const [index, row] of rows.entries()) {
    deps.signal.throwIfAborted();
    let error: unknown;
    let accepted = false;
    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      deps.signal.throwIfAborted();
      deps.progress(index, attempt, 'sending');
      try {
        await deps.send(row, index, attempt);
        accepted = true;
        break;
      } catch (cause) {
        error = cause;
      }
    }
    if (accepted) {
      sent++;
      deps.progress(index, 0, 'sent');
    } else {
      failed++;
      deps.progress(index, options.maxAttempts, 'failed');
      if (options.failure === 'abort') throw error;
    }
    if (index < rows.length - 1) {
      const delay = forwardDelay(deps.text(row), options);
      if (delay) await sleep(delay);
    }
  }
  return { sent, failed };
}
