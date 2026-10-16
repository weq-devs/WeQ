/** Shared bounded HTTP transport for QQ web cgis. */
import { isQzonePageRequest, waitForQzonePage } from '../../common/qzone_pagination';

export type WebRequestErrorKind =
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'rate-limit'
  | 'authentication'
  | 'http'
  | 'response-too-large'
  | 'decode';

export class WebRequestError extends Error {
  constructor(
    readonly kind: WebRequestErrorKind,
    message: string,
    readonly options: {
      status?: number;
      retryAfterMs?: number;
      retryable?: boolean;
      attempt?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'WebRequestError';
  }

  get status(): number | undefined {
    return this.options.status;
  }

  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
}

export interface WebRetryPolicy {
  /** Total attempts including the first request. */
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface WebRequestInit {
  redirect?: 'error';
  method?: 'GET' | 'POST';
  cookie: string;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Total work budget including retries, excluding pagination quota waits. */
  totalTimeoutMs?: number;
  /** Explicit retry budget. Omitted means one attempt and never replays a request. */
  retry?: WebRetryPolicy;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_MAX_MS = 5_000;

/** Conservative policy for idempotent read cgis. Write calls must not use it. */
export const WEB_READ_RETRY: WebRetryPolicy = { maxAttempts: 2 };

function targetLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return 'QQ Web CGI';
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status !== 501);
}

function validate(init: WebRequestInit): {
  timeoutMs: number;
  maxBytes: number;
  totalTimeoutMs: number;
  retry: Required<WebRetryPolicy>;
} {
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const totalTimeoutMs = init.totalTimeoutMs ?? timeoutMs;
  const maxBytes = init.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const retry = {
    maxAttempts: init.retry?.maxAttempts ?? 1,
    baseDelayMs: init.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_MS,
    maxDelayMs: init.retry?.maxDelayMs ?? DEFAULT_RETRY_MAX_MS,
  };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('web cgi timeout 无效');
  if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs <= 0)
    throw new Error('web cgi 总时限无效');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('web cgi 响应上限无效');
  if (!Number.isSafeInteger(retry.maxAttempts) || retry.maxAttempts < 1)
    throw new Error('web cgi 重试次数无效');
  if (!Number.isSafeInteger(retry.baseDelayMs) || retry.baseDelayMs < 0)
    throw new Error('web cgi 重试间隔无效');
  if (!Number.isSafeInteger(retry.maxDelayMs) || retry.maxDelayMs < retry.baseDelayMs)
    throw new Error('web cgi 最大重试间隔无效');
  return { timeoutMs, maxBytes, totalTimeoutMs, retry };
}

async function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    throw new WebRequestError('cancelled', 'QQ Web 请求已取消', { cause: signal.reason });
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const cancel = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(
        new WebRequestError('cancelled', 'QQ Web 请求已取消', {
          cause: signal?.reason,
        }),
      );
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/** Enforce cancellation even when a transport or stream ignores AbortSignal. */
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => {
      signal.removeEventListener('abort', cancel);
      reject(signal.reason);
    };
    signal.addEventListener('abort', cancel, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener('abort', cancel);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      },
    );
    if (signal.aborted) cancel();
  });
}

async function requestOnce(
  url: string,
  init: WebRequestInit,
  timeoutMs: number,
  maxBytes: number,
  attempt: number,
): Promise<Uint8Array> {
  const method = init.method ?? 'GET';
  if (init.signal?.aborted)
    throw new WebRequestError('cancelled', 'QQ Web 请求已取消', {
      attempt,
      cause: init.signal.reason,
    });
  const controller = new AbortController();
  const cancel = (): void => controller.abort(init.signal?.reason);
  init.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const target = targetLabel(url);
  try {
    const fetched = fetch(url, {
      method,
      redirect: init.redirect,
      headers: {
        Cookie: init.cookie,
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...init.headers,
      },
      body:
        method === 'POST'
          ? typeof init.body === 'string'
            ? init.body
            : init.body
              ? Buffer.from(init.body)
              : ''
          : undefined,
      signal: controller.signal,
    });
    void fetched.then(
      (late) => {
        if (controller.signal.aborted) void late.body?.cancel().catch(() => {});
      },
      () => {},
    );
    const res = await bounded(fetched, controller.signal);
    controller.signal.throwIfAborted();
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      const delay = parseRetryAfter(res.headers.get('retry-after'));
      const limited = res.status === 429;
      const authentication = res.status === 401 || res.status === 403;
      const suffix = delay === undefined ? '' : `，建议 ${Math.ceil(delay / 1000)} 秒后重试`;
      throw new WebRequestError(
        limited ? 'rate-limit' : authentication ? 'authentication' : 'http',
        limited
          ? `QQ Web 接口请求过于频繁${suffix}`
          : authentication
            ? `QQ Web 身份认证失败（HTTP ${res.status}）`
            : `QQ Web 接口返回 HTTP ${res.status}（${target}）${suffix}`,
        {
          status: res.status,
          retryAfterMs: delay,
          retryable: retryableStatus(res.status),
          attempt,
        },
      );
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {
      void res.body?.cancel().catch(() => {});
      throw new WebRequestError('response-too-large', `QQ Web 响应超过 ${maxBytes} 字节`, {
        attempt,
      });
    }
    if (!res.body) return new Uint8Array();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;

    try {
      for (;;) {
        const { done, value } = await bounded(reader.read(), controller.signal);
        if (done) break;
        bytes += value.length;
        if (bytes > maxBytes) {
          void reader.cancel().catch(() => {});
          throw new WebRequestError('response-too-large', `QQ Web 响应超过 ${maxBytes} 字节`, {
            attempt,
          });
        }
        chunks.push(value);
      }
      controller.signal.throwIfAborted();
      return new Uint8Array(Buffer.concat(chunks, bytes));
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof WebRequestError) throw error;
    if (init.signal?.aborted)
      throw new WebRequestError('cancelled', 'QQ Web 请求已取消', {
        attempt,
        cause: init.signal.reason ?? error,
      });
    if (controller.signal.aborted)
      throw new WebRequestError('timeout', `QQ Web 请求超时（${timeoutMs}ms）`, {
        retryable: true,
        attempt,
        cause: error,
      });
    throw new WebRequestError('network', `QQ Web 网络请求失败（${target}）`, {
      retryable: true,
      attempt,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', cancel);
  }
}

/** Bounded binary HTTP; retries require an explicitly supplied read budget. */
export async function webRequestBytes(url: string, init: WebRequestInit): Promise<Uint8Array> {
  const { timeoutMs, maxBytes, totalTimeoutMs, retry } = validate(init);
  let deadline = Date.now() + totalTimeoutMs;
  let lastError: WebRequestError | null = null;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    try {
      if (isQzonePageRequest(url)) {
        const queuedAt = Date.now();
        try {
          await waitForQzonePage(init.signal);
        } catch (cause) {
          throw new WebRequestError('cancelled', '空间翻页等待已取消', { cause, attempt });
        }
        deadline += Date.now() - queuedAt;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new WebRequestError('timeout', 'QQ Web 请求已超过总时限', { attempt });
      return await requestOnce(url, init, Math.min(timeoutMs, remaining), maxBytes, attempt);
    } catch (error) {
      if (!(error instanceof WebRequestError)) throw error;
      lastError = error;
      if (!error.retryable || attempt >= retry.maxAttempts) throw error;
      // Respect a server-requested cooldown longer than our local wait budget by
      // surfacing it to the user instead of retrying too early.
      if ((error.retryAfterMs ?? 0) > retry.maxDelayMs) throw error;
      const exponential = Math.min(
        retry.maxDelayMs,
        retry.baseDelayMs * 2 ** Math.max(0, attempt - 1),
      );
      const delay = Math.max(exponential, error.retryAfterMs ?? 0);
      if (delay >= deadline - Date.now()) throw error;
      await waitForRetry(delay, init.signal);
    }
  }
  throw lastError ?? new Error('QQ Web 请求失败');
}

/** GET/POST and return response text, sharing the binary transport's limits and errors. */
export async function webRequestText(url: string, init: WebRequestInit): Promise<string> {
  return new TextDecoder().decode(await webRequestBytes(url, init));
}

/** GET/POST and parse the response as JSON. */
export async function webRequestJson<T>(url: string, init: WebRequestInit): Promise<T> {
  const text = await webRequestText(url, init);
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new WebRequestError('decode', `QQ Web 接口返回了无法解析的数据（${targetLabel(url)}）`, {
      cause,
    });
  }
}
