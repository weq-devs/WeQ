import http from 'node:http';
import https from 'node:https';
import { CookieJar } from 'tough-cookie';
import { MailFailure } from './types';
import { encodeMailForm, type MailObject } from './wire';

const AUTH_HOSTS = new Set([
  'xui.ptlogin2.qq.com',
  'ssl.ptlogin2.qq.com',
  'ptlogin2.qq.com',
  'ptlogin2.mail.qq.com',
  'wx.mail.qq.com',
  'mail.qq.com',
]);
export const MAIL_LOCAL_HOST = 'localhost.ptlogin2.qq.com';
const MAX_RESPONSE = 8 * 1024 * 1024;

export interface MailResponse {
  status: number;
  location?: string;
  body: string;
}

export interface MailRequest {
  signal?: AbortSignal;
  form?: MailObject;
  localPort?: number;
}

export interface MailTransport {
  readonly jar: CookieJar;
  request(url: string | URL, options?: MailRequest): Promise<MailResponse>;
  dispose(): void;
}

/** 公网必须验证证书；本机例外只能进入已探测的 QQ 端口。 */
export function mailRequestTarget(url: URL, localPort?: number): URL {
  if (url.username || url.password || url.hash)
    throw new MailFailure('business', '邮箱请求地址无效。');
  if (localPort !== undefined) {
    if (
      !Number.isInteger(localPort) ||
      localPort < 1 ||
      localPort > 65535 ||
      url.hostname !== '127.0.0.1' ||
      Number(url.port) !== localPort ||
      url.protocol !== (localPort % 2 ? 'https:' : 'http:')
    )
      throw new MailFailure('business', 'QQ 本机认证地址无效。');
    const logical = new URL(url);
    logical.hostname = MAIL_LOCAL_HOST;
    return logical;
  }
  if (
    url.protocol !== 'https:' ||
    (url.port && url.port !== '443') ||
    !AUTH_HOSTS.has(url.hostname)
  )
    throw new MailFailure('business', '邮箱拒绝了不受信任的请求地址。');
  return url;
}

export class MailHttp implements MailTransport {
  readonly jar = new CookieJar();
  private readonly controller = new AbortController();

  async request(raw: string | URL, options: MailRequest = {}): Promise<MailResponse> {
    const url = new URL(raw);
    const logical = mailRequestTarget(url, options.localPort);
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.controller.signal])
      : this.controller.signal;
    signal.throwIfAborted();
    const body = options.form ? encodeMailForm(options.form) : undefined;
    const headers: Record<string, string | number> = {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36',
      Referer: 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin',
      Cookie: await this.jar.getCookieString(logical.href),
    };
    if (options.localPort !== undefined) {
      headers.Host = `${MAIL_LOCAL_HOST}:${options.localPort}`;
      headers.Origin = 'https://xui.ptlogin2.qq.com';
    } else if (options.form) {
      headers.Origin = 'https://wx.mail.qq.com';
      headers.Referer = 'https://wx.mail.qq.com/';
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = client.request(
        url,
        {
          method: body === undefined ? 'GET' : 'POST',
          headers,
          signal,
          ...(options.localPort !== undefined && url.protocol === 'https:'
            ? { rejectUnauthorized: false, servername: MAIL_LOCAL_HOST }
            : {}),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > MAX_RESPONSE) request.destroy(new Error('response_limit'));
            else chunks.push(chunk);
          });
          response.on('error', () => reject(new MailFailure('network', '邮箱连接中断，请重试。')));
          response.on('end', () => {
            void (async () => {
              for (const cookie of response.headers['set-cookie'] ?? []) {
                await this.jar.setCookie(cookie, logical.href, { ignoreError: true });
              }
              signal.throwIfAborted();
              resolve({
                status: response.statusCode ?? 0,
                location: response.headers.location,
                body: Buffer.concat(chunks).toString('utf8'),
              });
            })().catch(() => reject(new MailFailure('network', '邮箱请求已取消。')));
          });
        },
      );
      request.setTimeout(20_000, () => request.destroy(new Error('timeout')));
      request.on('error', () =>
        reject(
          new MailFailure(
            'network',
            signal.aborted ? '邮箱请求已取消。' : '邮箱网络请求失败，请稍后重试。',
          ),
        ),
      );
      request.end(body);
    });
  }

  dispose(): void {
    this.controller.abort();
    this.jar.removeAllCookiesSync();
  }
}
