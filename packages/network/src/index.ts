import { AsyncLocalStorage } from 'node:async_hooks';
import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici';
import { Readable } from 'node:stream';
import { FILE_MIRRORS } from './mirrors.mjs';

export type NetworkFetch = typeof fetch;
let installed: NetworkFetch | undefined;
const scoped = new AsyncLocalStorage<NetworkFetch>();
let proxy: EnvHttpProxyAgent | undefined;
let proxyKey = '';

export function setNetworkTransport(transport?: NetworkFetch) {
  installed = transport;
}
export function withNetworkTransport<T>(transport: NetworkFetch, work: () => T): T {
  return scoped.run(transport, work);
}
/** 桌面注入 Chromium；独立 Node 宿主与 worker 明确处理环境代理。 */
export const networkFetch: NetworkFetch = async (input, init) => {
  const transport = scoped.getStore() ?? installed;
  if (transport) return transport(input, init);
  const env = process.env;
  const key = JSON.stringify([
    env.http_proxy ?? env.HTTP_PROXY,
    env.https_proxy ?? env.HTTPS_PROXY,
    env.no_proxy ?? env.NO_PROXY,
  ]);
  if (!env.http_proxy && !env.HTTP_PROXY && !env.https_proxy && !env.HTTPS_PROXY)
    return globalThis.fetch(input, init);
  if (!proxy || proxyKey !== key) {
    if (proxy) void proxy.close();
    proxy = new EnvHttpProxyAgent();
    proxyKey = key;
  }
  // 使用适配器自己的 Undici，避免 Node 内置 Undici 与依赖版本的 dispatcher 类型混用。
  const request = new Request(input, init);
  const outgoing = request.body?.getReader();
  async function* upload() {
    const abort = () => {
      void outgoing?.cancel(request.signal.reason).catch(() => {});
    };
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        request.signal.throwIfAborted();
        const chunk = await outgoing!.read();
        if (chunk.done) return;
        yield chunk.value;
      }
    } finally {
      request.signal.removeEventListener('abort', abort);
      outgoing?.releaseLock();
    }
  }
  const response = await proxyFetch(request.url, {
    method: request.method,
    headers: [...request.headers],
    body: outgoing ? Readable.from(upload()) : undefined,
    duplex: 'half',
    signal: request.signal,
    redirect: request.redirect,
    dispatcher: proxy,
  });
  const reader = response.body?.getReader();
  const body = reader
    ? new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) controller.close();
              else controller.enqueue(chunk.value);
            } catch (error) {
              controller.error(error);
            }
          },
          cancel: (reason) => reader.cancel(reason),
        },
        { highWaterMark: 0 },
      )
    : null;
  const result = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers],
  });
  Object.defineProperties(result, {
    url: { value: response.url },
    redirected: { value: response.redirected },
  });
  return result;
};

export function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

const HEALTH_TTL = 30 * 60_000;
const health = new Map<string, { at: number; ok: boolean; speed: number }>();
const keyOf = (url: string) => new URL(url).origin;
export function clearSourceHealth() {
  health.clear();
}
export function recordSourceHealth(url: string, ok: boolean, speed = 0) {
  health.delete(keyOf(url));
  health.set(keyOf(url), { at: Date.now(), ok, speed });
  while (health.size > 64) health.delete(health.keys().next().value!);
}
export function downloadSources(url: string): string[] {
  const parsed = new URL(url);
  return parsed.origin === 'https://github.com' &&
    /^\/[^/]+\/[^/]+\/releases\/download\//.test(parsed.pathname)
    ? FILE_MIRRORS.map((prefix) => `${prefix}${url}`)
    : [url];
}
export function orderSources(sources: readonly string[]): string[] {
  const value = (url: string) => {
    const state = health.get(keyOf(url));
    return state && Date.now() - state.at < HEALTH_TTL ? state : undefined;
  };
  return [...new Set(sources)].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    return (
      (y?.ok ? 1 : y ? -1 : 0) - (x?.ok ? 1 : x ? -1 : 0) ||
      (y?.ok && x?.ok ? y.speed - x.speed || y.at - x.at : 0)
    );
  });
}
/** 只探测三个真实文件分段，不扫描全部镜像或只凭清单延迟判断带宽。 */
export async function resolveDownloadSources(sources: readonly string[], signal?: AbortSignal) {
  const ordered = orderSources(sources);
  if (
    ordered.length < 2 ||
    ordered.some((url) => {
      const state = health.get(keyOf(url));
      return state?.ok && Date.now() - state.at < HEALTH_TTL;
    })
  )
    return ordered;
  await Promise.all(
    ordered.slice(0, 3).map(async (url) => {
      const controller = new AbortController();
      const requestSignal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(4000),
        ...(signal ? [signal] : []),
      ]);
      const at = performance.now();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await bounded(
          networkFetch(url, { signal: requestSignal, headers: { Range: 'bytes=0-65535' } }),
          requestSignal,
        );
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error('source unavailable');
        }
        reader = response.body.getReader();
        let bytes = 0;
        while (bytes < 65536) {
          const chunk = await bounded(reader.read(), requestSignal);
          if (chunk.done) break;
          bytes += chunk.value.length;
        }
        if (!bytes) throw new Error('empty source');
        recordSourceHealth(url, true, bytes / Math.max(0.001, (performance.now() - at) / 1000));
      } catch {
        if (!signal?.aborted) recordSourceHealth(url, false);
      } finally {
        controller.abort();
        void reader?.cancel().catch(() => {});
      }
    }),
  );
  signal?.throwIfAborted();
  return orderSources(ordered);
}

/** 小型公开文件：每批最多三个请求，首个通过内容校验的结果胜出。 */
export async function fetchSourceJson<T>(
  url: string,
  validate: (value: unknown) => T,
  options: { signal?: AbortSignal; fetcher?: NetworkFetch; maxBytes?: number } = {},
): Promise<T> {
  const sources = orderSources(downloadSources(url));
  const deadline = Date.now() + 20000;
  let error: unknown = new Error('没有可用的资源来源');
  for (let at = 0; at < sources.length && Date.now() < deadline; at += 3) {
    options.signal?.throwIfAborted();
    const controllers: AbortController[] = [];
    const works = sources.slice(at, at + 3).map(async (source) => {
      const controller = new AbortController();
      controllers.push(controller);
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(Math.max(1, Math.min(8000, deadline - Date.now()))),
        ...(options.signal ? [options.signal] : []),
      ]);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const fetched = (options.fetcher ?? networkFetch)(source, { signal });
        void fetched.then(
          (response) => {
            if (signal.aborted) void response.body?.cancel().catch(() => {});
          },
          () => {},
        );
        const response = await bounded(fetched, signal);
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error(`资源清单 HTTP ${response.status}`);
        }
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
          const item = await bounded(reader.read(), signal);
          if (item.done) break;
          bytes += item.value.length;
          if (bytes > (options.maxBytes ?? 2 * 1024 ** 2)) throw new Error('资源清单过大');
          chunks.push(item.value);
        }
        const value = validate(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        recordSourceHealth(source, true);
        return value;
      } catch (failure) {
        if (!controller.signal.aborted && !options.signal?.aborted)
          recordSourceHealth(source, false);
        throw failure;
      } finally {
        controller.abort();
        void reader?.cancel().catch(() => {});
      }
    });
    try {
      return await Promise.any(works);
    } catch (failure) {
      error = failure instanceof AggregateError ? failure.errors.at(-1) : failure;
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(works);
    }
  }
  options.signal?.throwIfAborted();
  throw error;
}
