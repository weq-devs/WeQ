import { app, net, session, type Session } from 'electron';
import { networkInterfaces } from 'node:os';
import type { Readable } from 'node:stream';
import { setNetworkTransport, clearSourceHealth, type NetworkFetch } from '@weq/network';

const ANNOUNCEMENT_PARTITION = 'weq-announcements';

function chromiumHeaders(source: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, values] of Object.entries(source)) {
    for (const value of Array.isArray(values) ? values : [values]) {
      if (value === undefined) continue;
      // Electron 可能将 UTF-8 头解成 Unicode；还原为 Fetch 接受的字节串，已有字节串不重编码。
      headers.append(
        name,
        /[\u0100-\uffff]/.test(value) ? Buffer.from(value, 'utf8').toString('latin1') : value,
      );
    }
  }
  return headers;
}

function chromiumRead(url: string, source: Request, headers: Headers, requestSession?: Session) {
  return new Promise<Response>((resolve, reject) => {
    const { method, referrerPolicy, signal } = source;
    signal.throwIfAborted();
    const request = net.request({
      url,
      method,
      headers: Object.fromEntries(headers),
      referrerPolicy: referrerPolicy || undefined,
      redirect: 'manual',
      credentials: 'omit',
      bypassCustomProtocolHandlers: true,
      session: requestSession,
    });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      controller?.error(error);
      reject(error);
    };
    const abort = () => {
      fail(signal.reason);
      request.abort();
    };
    signal.addEventListener('abort', abort, { once: true });
    request.on('error', fail);
    request.on('redirect', (status, _method, redirectUrl, responseHeaders) => {
      if (finished) return;
      try {
        const next = chromiumHeaders(responseHeaders);
        next.set('location', new URL(redirectUrl, url).href);
        const result = new Response(null, { status, headers: next });
        finished = true;
        cleanup();
        resolve(result);
        request.abort();
      } catch (error) {
        fail(error);
        request.abort();
      }
    });
    request.on('response', (incoming) => {
      if (finished) return;
      try {
        // Electron 声明遗漏了官方文档承诺的 Readable 接口方法。
        const response = incoming as typeof incoming & Pick<Readable, 'pause' | 'resume'>;
        response.pause();
        const receivedHeaders = chromiumHeaders(response.headers);
        const body =
          method === 'HEAD' || [204, 205, 304].includes(response.statusCode)
            ? null
            : new ReadableStream<Uint8Array>(
                {
                  start(value) {
                    controller = value;
                  },
                  pull() {
                    response.resume();
                  },
                  cancel() {
                    finished = true;
                    cleanup();
                    request.abort();
                  },
                },
                { highWaterMark: 0 },
              );
        response.on('end', () => {
          if (!finished) {
            finished = true;
            cleanup();
            controller?.close();
          }
        });
        response.on('data', (chunk) => {
          if (!finished) {
            response.pause();
            controller?.enqueue(new Uint8Array(chunk));
          }
        });
        response.on('error', fail);
        response.on('aborted', () => fail(new TypeError('下载连接中断')));
        resolve(new Response(body, { status: response.statusCode, headers: receivedHeaders }));
        if (!body) response.resume();
      } catch (error) {
        fail(error);
        request.abort();
      }
    });
    request.end();
  });
}

/** Chromium 的 Response.url 不可靠；读取请求手动跟随跳转并记录真实最终地址。 */
async function chromiumFetch(
  input: Parameters<NetworkFetch>[0],
  init?: RequestInit,
  requestSession?: Session,
): Promise<Response> {
  const request = new Request(input, init);
  const options = {
    ...init,
    bypassCustomProtocolHandlers: true,
    credentials: init?.credentials ?? 'omit',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const headers = new Headers(request.headers);
    // Chromium 禁止调用方指定长度，沿用原正文并让网络栈计算。
    headers.delete('content-length');
    return net.fetch(input instanceof URL ? input.toString() : input, { ...options, headers });
  }
  let url = request.url;
  const headers = new Headers(request.headers);
  for (let redirects = 0; redirects <= 20; redirects++) {
    const response = await chromiumRead(url, request, headers, requestSession);
    Object.defineProperties(response, {
      url: { value: url },
      redirected: { value: redirects > 0 },
    });
    if (
      ![301, 302, 303, 307, 308].includes(response.status) ||
      !response.headers.has('location') ||
      request.redirect === 'manual'
    )
      return response;
    await response.body?.cancel();
    if (request.redirect === 'error') throw new TypeError('请求不允许重定向');
    const next = new URL(response.headers.get('location')!, url);
    if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password)
      throw new TypeError('下载重定向地址无效');
    if (next.origin !== new URL(url).origin) {
      headers.delete('authorization');
      headers.delete('cookie');
      headers.delete('proxy-authorization');
      if (request.referrerPolicy === 'no-referrer-when-downgrade') headers.delete('referer');
    }
    url = next.toString();
  }
  throw new TypeError('下载重定向次数过多');
}

export const electronNetworkFetch: NetworkFetch = (input, init) => chromiumFetch(input, init);

export const electronAnnouncementFetch: NetworkFetch = (input, init) =>
  chromiumFetch(
    input,
    init,
    process.env.WEQ_DEV_CONSOLE === '1' ? session.fromPartition(ANNOUNCEMENT_PARTITION) : undefined,
  );

type ReportTlsFailure = (host: string, error: string) => void;

function observeDevelopmentNetworkFailures(report: ReportTlsFailure) {
  // 公告使用独立会话，官方源、镜像及重定向都由公告刷新统一判定结果。
  const announcements = session.fromPartition(ANNOUNCEMENT_PARTITION);
  let active = true;
  const observe = (current: Session) => {
    if (current === announcements) return;
    current.webRequest.onErrorOccurred({ urls: ['https://*/*'] }, ({ url, error }) => {
      if (
        active &&
        (error === 'net::ERR_CONNECTION_CLOSED' || error === 'net::ERR_CERT_COMMON_NAME_INVALID')
      ) {
        report(new URL(url).hostname, error);
      }
    });
  };
  observe(session.defaultSession);
  app.on('session-created', observe);
  return () => {
    active = false;
    app.off('session-created', observe);
    session.defaultSession.webRequest.onErrorOccurred(null);
  };
}

export function installDesktopNetwork(reportTlsFailure: ReportTlsFailure) {
  setNetworkTransport(electronNetworkFetch);
  const stopObserving =
    process.env.WEQ_DEV_CONSOLE === '1'
      ? observeDevelopmentNetworkFailures(reportTlsFailure)
      : undefined;
  const fingerprint = () => JSON.stringify([net.online, networkInterfaces()]);
  let previous = fingerprint();
  const timer = setInterval(() => {
    const next = fingerprint();
    if (previous !== next) {
      previous = next;
      clearSourceHealth();
    }
  }, 5000);
  timer.unref();
  return () => {
    clearInterval(timer);
    stopObserving?.();
    setNetworkTransport();
  };
}
