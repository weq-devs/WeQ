/**
 * Thin `fetch` wrappers for QQ web cgis. They only add the cookie header, the
 * urlencoded content-type on POST, and turn a non-2xx / non-JSON response into a
 * clear error — everything cgi-specific (params, parsing) stays in the callers.
 */

export interface WebRequestInit {
  method?: 'GET' | 'POST';
  /** Full `Cookie` header value (see {@link cookieHeader}). */
  cookie: string;
  /** urlencoded form body; only sent on POST. */
  body?: string;
  /** Extra headers (e.g. Referer). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** GET/POST and return the raw response text. Throws on non-2xx. */
export async function webRequestText(url: string, init: WebRequestInit): Promise<string> {
  const method = init.method ?? 'GET';
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = init.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('web cgi timeout 无效');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('web cgi 响应上限无效');
  init.signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = (): void => controller.abort(init.signal?.reason);
  init.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`web cgi 请求超时（${timeoutMs}ms）`)),
    timeoutMs,
  );
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Cookie: init.cookie,
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...init.headers,
      },
      body: method === 'POST' ? (init.body ?? '') : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`web cgi ${res.status} ${res.statusText}: ${url}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {
      await res.body?.cancel();
      throw new Error(`web cgi 响应超过 ${maxBytes} 字节`);
    }
    if (!res.body) return '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new Error(`web cgi 响应超过 ${maxBytes} 字节`);
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error(init.signal?.aborted ? 'web cgi 请求已取消' : 'web cgi 请求超时');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', cancel);
  }
}

/** GET/POST and parse the response as JSON. Throws on non-2xx or non-JSON. */
export async function webRequestJson<T>(url: string, init: WebRequestInit): Promise<T> {
  const text = await webRequestText(url, init);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`web cgi returned non-JSON (${url}): ${text.slice(0, 200)}`);
  }
}
