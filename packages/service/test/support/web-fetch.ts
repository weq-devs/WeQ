/**
 * 把全局 `fetch` 换成可控的桩，给 web cgi 的离线单测用。
 *
 * 背景：qzone / 群 web 的实现已经收编进 `@weqbot/protocol`，kernel 里直接调
 * 全局 `fetch`（它是纯 TS，不依赖 WeQ 的 `networkFetch`）。所以 WeQ 侧的测试
 * 不能再 mock `src/account/web/http`，只能从更底层拦。
 *
 * 这个桩把调用摊平成 `(url, init)` 两个位置参数，与原先 mock `webRequestJson`
 * 时拿到的形状一致，测试里的断言基本不用改。返回值按
 * `new Response(body, { status })` 构造，走真实的 `res.ok` / `res.text()` 路径
 * —— 比原先直接给对象更接近生产。
 */

export interface StubbedFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** 原始 body：字符串原样，二进制转成 Buffer。 */
  body: string | Buffer | undefined;
  /**
   * 原始 `RequestInit`，供断言 `retry` / `signal` / `redirect` 这类传输层细节。
   *
   * 注意 `retry` 是 **WeQ/kernel 在调用 `webRequest*` 时传的参数**，不会真的到达
   * `fetch` —— 它由传输层自己消费。所以这里把函数收到的 init 原样留住即可，
   * 断言的值与调用方写的一致。
   */
  init: RequestInit & { retry?: unknown };
}

export type StubbedFetchReply =
  | { status?: number; text: string; headers?: Record<string, string> }
  | { status?: number; bytes: Uint8Array; headers?: Record<string, string> }
  /** 模拟网络层失败（连接被重置 / DNS 失败）：fetch 本身 reject。 */
  | { error: Error };

export interface StubbedFetch {
  readonly calls: StubbedFetchCall[];
  /** 后续每次调用都返回同一个响应。 */
  reply(reply: StubbedFetchReply): void;
  /** 依次消费，用完后回到 `reply` 的默认值。 */
  replyOnce(reply: StubbedFetchReply): void;
  /** 最近一次调用的解构结果；没有调用时抛错。 */
  last(): StubbedFetchCall;
  at(index: number): StubbedFetchCall;
  reset(): void;
  restore(): void;
}

function toCall(input: unknown, init: RequestInit | undefined): StubbedFetchCall {
  const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
  const headers: Record<string, string> = {};
  const raw = init?.headers;
  // 保留调用方写的原始大小写（`fetch` 本身也不改），断言里两种写法都能用。
  if (raw && !(raw instanceof Headers) && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, string>)) {
      if (value !== undefined) headers[key] = String(value);
    }
  } else if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      headers[key] = value;
    });
  }
  let body: string | Buffer | undefined;
  if (typeof init?.body === 'string') body = init.body;
  else if (init?.body instanceof Uint8Array) body = Buffer.from(init.body);
  return {
    url,
    method: (init?.method ?? 'GET').toUpperCase(),
    headers,
    body,
    init: (init ?? {}) as RequestInit & { retry?: unknown },
  };
}

function toResponse(reply: StubbedFetchReply): Response {
  const status = reply.status ?? 200;
  if ('bytes' in reply) {
    return new Response(reply.bytes, {
      status,
      headers: { 'content-type': 'application/octet-stream', ...reply.headers },
    });
  }
  return new Response(reply.text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...reply.headers },
  });
}

/** 装一个桩，返回句柄。用完记得 `restore()`（或在 afterEach 里调）。 */
export function stubWebFetch(): StubbedFetch {
  const calls: StubbedFetchCall[] = [];
  let fallback: StubbedFetchReply = { status: 200, text: '' };
  const once: StubbedFetchReply[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push(toCall(input, init));
    const reply = once.shift() ?? fallback;
    if ('error' in reply) throw reply.error;
    return toResponse(reply);
  }) as typeof fetch;

  return {
    calls,
    reply(next) {
      fallback = next;
    },
    replyOnce(next) {
      once.push(next);
    },
    last() {
      const call = calls.at(-1);
      if (!call) throw new Error('fetch 没有被调用');
      return call;
    },
    at(index) {
      const call = calls[index];
      if (!call) throw new Error(`fetch 第 ${index} 次调用不存在（共 ${calls.length} 次）`);
      return call;
    },
    reset() {
      calls.length = 0;
      once.length = 0;
      fallback = { status: 200, text: '' };
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}
