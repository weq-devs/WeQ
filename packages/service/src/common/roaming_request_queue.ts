import { setTimeout } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

let tail = Promise.resolve();
let nextStart = 0;

/** Shared by manual jobs, individual gaps and exports; never overlap native history reads. */
export async function withRoamingRequest<T>(
  operation: () => Promise<T>,
  options: { signal?: AbortSignal; intervalMs?: number } = {},
): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const interval =
    typeof options.intervalMs === 'number' && Number.isFinite(options.intervalMs)
      ? Math.max(500, Math.min(60000, options.intervalMs))
      : 500;
  try {
    await previous;
    options.signal?.throwIfAborted();
    const wait = Math.max(0, Math.ceil(nextStart - performance.now()));
    if (wait) await setTimeout(wait, undefined, { signal: options.signal });
    options.signal?.throwIfAborted();
    entered = true;
    return await operation();
  } finally {
    // Cool down after the previous read settles, using a monotonic clock.
    if (entered) nextStart = performance.now() + interval;
    release();
  }
}
