import type { RepeatElement } from './messageRepeat';

export interface ForwardOptions {
  mode: 'fixed' | 'text' | 'original';
  intervalMs: number;
  msPerCharacter: number;
  nonTextMs: number;
  /** -1 表示不限制；界面以秒编辑，内部仍以毫秒计时。 */
  maxIntervalMs: number;
  jitterMs: number;
  maxAttempts: number;
  failure: 'skip' | 'abort';
}
export const DEFAULT_FORWARD_OPTIONS: ForwardOptions = {
  mode: 'fixed',
  intervalMs: 0,
  msPerCharacter: 1000,
  nonTextMs: 5000,
  maxIntervalMs: -1,
  jitterMs: 0,
  maxAttempts: 1,
  failure: 'skip',
};
export interface ForwardContent {
  text: string;
  nonText: boolean;
  timestampMs?: number;
}

export function forwardMessageContent(message: {
  body: string;
  qqElements?: readonly RepeatElement[];
  createdAt?: string;
}): ForwardContent {
  // 引用指针不会随逐条转发发出，不把引用摘要当作额外内容或文字。
  const elements = message.qqElements?.filter((element) => element.type !== 'reply') ?? [];
  return {
    timestampMs: message.createdAt ? Date.parse(message.createdAt) : undefined,
    text: elements.length
      ? elements
          .filter((element) => element.type === 'text')
          .map((element) => String(element.data?.textContent ?? ''))
          .join('')
      : message.body,
    nonText: elements.some((element) => element.type !== 'text'),
  };
}

export function validateForwardOptions(options: ForwardOptions): void {
  if (
    !['fixed', 'text', 'original'].includes(options.mode) ||
    !['skip', 'abort'].includes(options.failure) ||
    !Number.isInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    options.maxAttempts > 20 ||
    !Number.isInteger(options.maxIntervalMs) ||
    options.maxIntervalMs < -1 ||
    options.maxIntervalMs > 3_600_000 ||
    [options.intervalMs, options.msPerCharacter, options.nonTextMs, options.jitterMs].some(
      (value) => !Number.isFinite(value) || value < 0 || value > 3_600_000,
    )
  )
    throw new Error('转发参数无效');
}

export function forwardDelay(
  content: string | ForwardContent,
  options: ForwardOptions,
  random = Math.random,
  nextContent?: string | ForwardContent,
): number {
  const { text, nonText } =
    typeof content === 'string' ? { text: content, nonText: false } : content;
  const base =
    options.mode === 'text'
      ? nonText
        ? options.nonTextMs
        : Array.from(text).length * options.msPerCharacter
      : options.mode === 'original'
        ? originalMessageGap(content, nextContent)
        : options.intervalMs;
  const delay = Math.max(0, Math.round(base + (random() * 2 - 1) * options.jitterMs));
  return options.mode === 'fixed' || options.maxIntervalMs === -1
    ? delay
    : Math.min(options.maxIntervalMs, delay);
}

function originalMessageGap(
  content: string | ForwardContent,
  next?: string | ForwardContent,
): number {
  const currentTime = typeof content === 'string' ? undefined : content.timestampMs;
  const nextTime = typeof next === 'string' ? undefined : next?.timestampMs;
  return Number.isFinite(currentTime) && Number.isFinite(nextTime)
    ? Math.max(0, nextTime! - currentTime!)
    : 0;
}

/** 各目标并行，只估算一条目标队列的可控等待，不按目标数累乘。 */
export function estimateForwardDuration(
  rows: readonly (string | ForwardContent)[],
  options: ForwardOptions,
  targetCount: number,
): { minMs: number; maxMs: number } {
  validateForwardOptions(options);
  if (!Number.isInteger(targetCount) || targetCount < 0) throw new Error('转发目标数量无效');
  const waits =
    targetCount === 0 || rows.length <= 1 ? [] : options.mode === 'text' ? rows : rows.slice(0, -1);
  return {
    minMs: waits.reduce((sum, row, i) => sum + forwardDelay(row, options, () => 0, rows[i + 1]), 0),
    maxMs: waits.reduce((sum, row, i) => sum + forwardDelay(row, options, () => 1, rows[i + 1]), 0),
  };
}

export function formatForwardDuration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms)) / 1000;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = Number((seconds % 60).toFixed(3));
  return [
    hours ? `${hours} 小时` : '',
    minutes ? `${minutes} 分` : '',
    remainder || !seconds ? `${remainder} 秒` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function formatForwardClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}
export async function forwardSequentially<T>(
  rows: readonly T[],
  options: ForwardOptions,
  deps: {
    send: (row: T, index: number, attempt: number) => Promise<void>;
    text: (row: T) => string;
    nonText?: (row: T) => boolean;
    time?: (row: T) => number | undefined;
    signal: AbortSignal;
    progress: (index: number, attempt: number, state: 'sending' | 'sent' | 'failed') => void;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<{ sent: number; failed: number }> {
  validateForwardOptions(options);
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
        let timer: ReturnType<typeof setTimeout>;
        let remaining = ms;
        const wait = () => {
          // 浏览器定时器使用有符号 32 位延时，长消息不能溢出成立即发送。
          const chunk = Math.min(remaining, 2_147_483_647);
          remaining -= chunk;
          timer = setTimeout(() => {
            if (remaining > 0) wait();
            else {
              deps.signal.removeEventListener('abort', abort);
              resolve();
            }
          }, chunk);
        };
        deps.signal.addEventListener('abort', abort, { once: true });
        wait();
      }));
  for (const [index, row] of rows.entries()) {
    deps.signal.throwIfAborted();
    if (options.mode === 'text' && rows.length > 1) {
      const delay = forwardDelay(
        { text: deps.text(row), nonText: deps.nonText?.(row) ?? false },
        options,
      );
      if (delay) await sleep(delay);
      deps.signal.throwIfAborted();
    }
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
    if (options.mode !== 'text' && index < rows.length - 1) {
      const delay = forwardDelay(
        { text: deps.text(row), nonText: false, timestampMs: deps.time?.(row) },
        options,
        Math.random,
        { text: '', nonText: false, timestampMs: deps.time?.(rows[index + 1]!) },
      );
      if (delay) await sleep(delay);
    }
  }
  return { sent, failed };
}
