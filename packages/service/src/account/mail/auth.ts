import type { NtHelperBinding } from '@weq/native';
import { Cookie } from 'tough-cookie';
import { MailHttp, type MailResponse, type MailTransport } from './http';
import { MailFailure } from './types';
import { MAIL_ORIGIN, mailEnvelope, text, type MailObject } from './wire';

type MailNative = Pick<NtHelperBinding, 'ptFetchMailSession'>;
const MAIL_SESSION_ORIGINS = new Set([MAIL_ORIGIN, 'https://mail.qq.com']);

function json(response: MailResponse): unknown {
  if (response.status !== 200) throw new MailFailure('network', '邮箱服务暂时不可用。');
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new MailFailure('business', '邮箱返回了无法识别的响应。');
  }
}

export class MailAuth {
  private sid = '';
  private panelPskey = '';
  private pending: Promise<void> | null = null;
  private lastValidated = 0;
  private refreshing: Promise<void> | null = null;
  private disposed = false;
  readonly transport: MailTransport;

  constructor(
    private readonly nt: MailNative,
    readonly uin: string,
    private readonly onlinePid: () => number | null,
    transport?: MailTransport,
  ) {
    this.transport = transport ?? new MailHttp();
  }

  get ready(): boolean {
    return !!this.sid && !this.disposed;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new MailFailure('auth', '邮箱会话已关闭。');
    if (this.sid) return;
    if (!this.onlinePid()) throw new MailFailure('offline', '请先登录当前账号的 QQ。');
    if (!this.pending)
      this.pending = this.login(signal).finally(() => {
        this.pending = null;
      });
    await this.pending;
    signal?.throwIfAborted();
  }

  private async login(signal?: AbortSignal): Promise<void> {
    if (!/^[1-9]\d{4,19}$/.test(this.uin)) throw new MailFailure('auth', 'QQ 账号无效。');
    const pid = this.onlinePid();
    if (!pid) throw new MailFailure('offline', '请先登录当前账号的 QQ。');
    const result = await this.nt.ptFetchMailSession(pid, this.uin);
    signal?.throwIfAborted();
    if (this.disposed || this.onlinePid() !== pid)
      throw new MailFailure('auth', 'QQ 账号状态已变化，请重新连接邮箱。');
    if (!result.success || !result.sid)
      throw new MailFailure(
        result.errorKind === 'offline' ? 'offline' : 'auth',
        result.msg || '邮箱登录失败，请重试。',
      );
    this.sid = result.sid;
    // 网页登录会删除 p_skey，但 QQ 面板提醒仍以它认证，不能依赖会话 CookieJar。
    this.panelPskey = result.panelPskey;
    await this.seedCookies(result.cookie);
    this.lastValidated = Date.now();
  }

  /** 把 native 返回的 Cookie 头灌进本地 jar，供附件下载 / WebSocket 复用。 */
  private async seedCookies(header: string): Promise<void> {
    for (const part of header.split(';')) {
      const cookie = Cookie.parse(part.trim());
      if (!cookie?.key || !cookie.value) continue;
      // native 只返回 Cookie 头，没有域属性；为两个受信任入口分别建立 host-only Cookie。
      for (const origin of MAIL_SESSION_ORIGINS)
        await this.transport.jar.setCookie(
          new Cookie({ key: cookie.key, value: cookie.value, path: '/', secure: true }),
          origin,
          { ignoreError: true },
        );
    }
  }

  async cgi(
    path: string,
    params: MailObject = {},
    options: { signal?: AbortSignal; write?: boolean } = {},
  ): Promise<MailObject> {
    if (!/^\/[a-z_]+\/[a-z_]+$/.test(path)) throw new MailFailure('business', '邮箱接口无效。');
    await this.connect(options.signal);
    if (Date.now() - this.lastValidated > 15 * 60_000) {
      if (!this.refreshing)
        this.refreshing = this.refresh(options.signal).finally(() => {
          this.refreshing = null;
        });
      await this.refreshing;
    }
    const run = async (): Promise<MailObject> =>
      mailEnvelope(
        json(
          await this.transport.request(`${MAIL_ORIGIN}${path}`, {
            signal: options.signal,
            form: { ...params, sid: this.sid, language: 'zh', r: `${Math.random()}${Date.now()}` },
          }),
        ),
      );
    try {
      return await run();
    } catch (error) {
      if (error instanceof MailFailure && error.kind === 'auth') {
        this.sid = '';
        if (!options.write) {
          await this.connect(options.signal);
          return run();
        }
      }
      throw error;
    }
  }

  private async refresh(signal?: AbortSignal): Promise<void> {
    try {
      const result = mailEnvelope(
        json(
          await this.transport.request(`${MAIL_ORIGIN}/login/login`, {
            signal,
            form: { sid: this.sid, auth_type: 6 },
          }),
        ),
      );
      if (!text(result.sid)) throw new MailFailure('auth', '邮箱登录已失效。');
      this.sid = text(result.sid);
      this.lastValidated = Date.now();
    } catch (error) {
      if (!(error instanceof MailFailure) || error.kind !== 'auth') throw error;
      this.sid = '';
      await this.connect(signal);
    }
  }

  async notificationQuery(signal?: AbortSignal): Promise<MailObject> {
    await this.connect(signal);
    return mailEnvelope(
      json(
        await this.transport.request(`${MAIL_ORIGIN}/qs/list_notify?f=json`, {
          signal,
          panelCookie: `p_uin=o${this.uin}; p_skey=${this.panelPskey}`,
        }),
      ),
    );
  }

  async downloadCredentials(
    source: URL,
    big: boolean,
    signal?: AbortSignal,
  ): Promise<{ url: URL; cookie: string }> {
    await this.connect(signal);
    let url = new URL(source);
    if (!MAIL_SESSION_ORIGINS.has(url.origin))
      throw new MailFailure('business', '附件下载入口不受信任。');
    url.searchParams.set('sid', this.sid);
    if (big) {
      const result = mailEnvelope(
        json(await this.transport.request(url, { signal, form: { func: 2, sid: this.sid } })),
      );
      const target = text(result.url);
      if (!target) throw new MailFailure('business', '超大附件未返回下载地址。');
      url = new URL(target, url);
    }
    const cookie = MAIL_SESSION_ORIGINS.has(url.origin)
      ? await this.transport.jar.getCookieString(url.href)
      : '';
    return { url, cookie };
  }

  async redact(html: string): Promise<string> {
    const cookies = [
      ...(await this.transport.jar.getCookies(`${MAIL_ORIGIN}/`)),
      ...(await this.transport.jar.getCookies('https://mail.qq.com/')),
      ...(await this.transport.jar.getCookies('https://ssl.ptlogin2.qq.com/')),
    ];
    const keys = new Set([
      'sid',
      'skey',
      'p_skey',
      'clientkey',
      'pt4_token',
      'airkey',
      'pt_login_sig',
    ]);
    const values = [
      this.sid,
      this.panelPskey,
      ...cookies.filter((cookie) => keys.has(cookie.key)).map((cookie) => cookie.value),
    ];
    let safe = html;
    for (const value of new Set(values))
      if (value.length >= 8) {
        safe = safe.split(value).join('[redacted]');
        safe = safe.split(encodeURIComponent(value)).join('[redacted]');
      }
    return safe;
  }

  async socketCredentials(sequence = 0): Promise<{ cookie: string; frame: string }> {
    await this.cgi('/login/checksid');
    const cookie = await this.transport.jar.getCookieString(`${MAIL_ORIGIN}/socket`);
    const scriptCookie = (
      await this.transport.jar.getCookies(`${MAIL_ORIGIN}/socket`, { http: false })
    )
      .map((entry) => entry.cookieString())
      .join('; ');
    return {
      cookie,
      frame: JSON.stringify({
        cmd: 0,
        product: 0,
        content: 'hello',
        http: {
          method: 'POST',
          path: '/online/socket_webmailpull',
          query: `set_ws=true&lastest_msg_seq=${sequence}&sid=${encodeURIComponent(this.sid)}`,
          header: { HOST: 'wx.mail.qq.com', Cookie: scriptCookie },
        },
      }),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.sid = '';
    this.panelPskey = '';
    this.transport.dispose();
  }
}
