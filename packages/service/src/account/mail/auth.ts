import type { NtHelperBinding } from '@weq/native';
import { buildPtlogin2JumpUrl } from '../web/ptlogin';
import { parseJsLiteral } from '../web/qzone';
import { MailHttp, type MailResponse, type MailTransport } from './http';
import { MailFailure } from './types';
import { MAIL_ORIGIN, mailEnvelope, object, text, type MailObject } from './wire';

export const MAIL_LOGIN_APP_ID = '522005705';
export const MAIL_LOGIN_DAID = '4';
export const MAIL_LANDING = `${MAIL_ORIGIN}/list/readtemplate?name=login_jump.html&scene=1&login_type=qq&from=qq_panel`;
const CALLBACK = `${MAIL_ORIGIN}/list/readtemplate?name=common_callback.html&login_type=qqPTLogin&origin=${encodeURIComponent(MAIL_ORIGIN)}`;
type MailNative = Pick<NtHelperBinding, 'probePtLoginPort'>;

function query(base: string, params: Record<string, string | number>): URL {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

export function localLoginArguments(body: string): unknown[] {
  const start = body.indexOf('('),
    end = body.lastIndexOf(')');
  if (start < 0 || end <= start) throw new MailFailure('auth', 'QQ 本机认证响应无效。');
  try {
    const args: unknown = parseJsLiteral(`[${body.slice(start + 1, end)}]`);
    if (!Array.isArray(args)) throw new Error('arguments');
    return args;
  } catch {
    throw new MailFailure('auth', 'QQ 本机认证响应无效。');
  }
}

export function localLoginAccounts(body: string): unknown[] {
  const start = body.indexOf('[');
  if (start < 0) throw new MailFailure('auth', 'QQ 未返回账号列表。');
  try {
    const value: unknown = parseJsLiteral(body.slice(start));
    if (!Array.isArray(value)) throw new Error('accounts');
    return value;
  } catch {
    throw new MailFailure('auth', 'QQ 本机账号列表无效。');
  }
}

export function mailCheckSigTarget(response: MailResponse): URL {
  let raw = response.location;
  if (!raw && response.status === 200) {
    const args = localLoginArguments(response.body);
    if (text(args[0]) !== '0')
      throw new MailFailure('auth', 'QQ 拒绝了邮箱快速登录，请重新登录 QQ。');
    raw = args.map(text).find((value) => value.startsWith('https://'));
  }
  if (!raw) throw new MailFailure('auth', 'QQ 未返回邮箱登录跳转。');
  const url = new URL(raw, 'https://ssl.ptlogin2.qq.com');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/check_sig' ||
    !new Set([
      'ssl.ptlogin2.qq.com',
      'ptlogin2.qq.com',
      'ptlogin2.mail.qq.com',
      'ssl.ptlogin2.mail.qq.com',
    ]).has(url.hostname)
  )
    throw new MailFailure('auth', '邮箱登录跳转地址无效。');
  url.hostname = 'ptlogin2.mail.qq.com';
  return url;
}

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
    const port = this.nt.probePtLoginPort(pid);
    if (!port.success)
      throw new MailFailure('offline', '无法连接 QQ 本机登录服务，请确认 QQ 已登录。');
    const params = {
      appid: MAIL_LOGIN_APP_ID,
      daid: MAIL_LOGIN_DAID,
      pt_3rd_aid: '0',
      u1: CALLBACK,
    };
    await this.transport.request(
      query('https://xui.ptlogin2.qq.com/cgi-bin/xlogin', {
        ...params,
        s_url: CALLBACK,
        style: '25',
        target: 'self',
        low_login: '1',
        enable_qlogin: '0',
      }),
      { signal },
    );
    const token = (await this.transport.jar.getCookies('https://xui.ptlogin2.qq.com/')).find(
      (cookie) => cookie.key === 'pt_local_token',
    )?.value;
    if (!token) throw new MailFailure('auth', 'QQ 快速登录未返回认证信息。');
    const local = `${port.port % 2 ? 'https' : 'http'}://127.0.0.1:${port.port}`;
    const localParams = {
      pt_aid: MAIL_LOGIN_APP_ID,
      daid: MAIL_LOGIN_DAID,
      pt_3rd_aid: '0',
      u1: CALLBACK,
      pt_local_tk: token,
      r: Math.random(),
    };
    const accounts = await this.transport.request(
      query(`${local}/pt_get_uins`, { ...localParams, callback: 'ptui_getuins_CB' }),
      { signal, localPort: port.port },
    );
    const listed = localLoginAccounts(accounts.body);
    if (
      !listed?.some(
        (entry: unknown) => text(object(entry).uin ?? object(entry).account) === this.uin,
      )
    )
      throw new MailFailure('auth', 'QQ 本机登录账号与当前 WeQ 账号不一致。');
    const ticket = await this.transport.request(
      query(`${local}/pt_get_st`, { ...localParams, clientuin: this.uin, callback: '__jp0' }),
      { signal, localPort: port.port },
    );
    const objectStart = ticket.body.indexOf('{');
    let metadata: MailObject = {};
    if (objectStart >= 0) {
      try {
        metadata = object(parseJsLiteral(ticket.body.slice(objectStart)));
      } catch {
        throw new MailFailure('auth', 'QQ 本机票据响应无效。');
      }
    }
    const keyIndex = text(metadata.keyindex ?? metadata.keyIndex) || '19';
    const clientKey = (await this.transport.jar.getCookies('https://ssl.ptlogin2.qq.com/')).find(
      (cookie) => cookie.key === 'clientkey',
    )?.value;
    if (!clientKey) throw new MailFailure('auth', '请在 QQ 中确认快速登录后重试。');
    const jumped = await this.transport.request(
      buildPtlogin2JumpUrl({ clientKey, keyIndex }, this.uin, MAIL_LANDING),
      { signal },
    );
    let target: URL | null = mailCheckSigTarget(jumped);
    for (let hops = 0; target && hops < 4; hops++) {
      const response = await this.transport.request(target, { signal });
      target =
        response.location && [301, 302, 303, 307, 308].includes(response.status)
          ? new URL(response.location, target)
          : null;
    }
    if (target) throw new MailFailure('auth', '邮箱登录跳转次数过多。');
    const mailCookies = await this.transport.jar.getCookies(`${MAIL_ORIGIN}/`);
    const pskey = mailCookies.findLast(
      (cookie) =>
        cookie.key === 'p_skey' &&
        (cookie.domain === 'mail.qq.com' || cookie.domain === 'wx.mail.qq.com'),
    )?.value;
    if (!pskey) throw new MailFailure('auth', 'QQ 未返回邮箱登录票据。');
    const result = json(
      await this.transport.request(
        `${MAIL_ORIGIN}/login/login?scene=1&login_type=qq&from=qq_panel&ss=0`,
        {
          signal,
          form: { auth_type: 3, p_uin: `o${this.uin}`, p_skey: pskey, scene: 1, from: 'qq_panel' },
        },
      ),
    );
    const data = mailEnvelope(result);
    if (text(object(object(result).head).location).includes('proxy_spwd'))
      throw new MailFailure('auth', '邮箱需要二次验证，请先在 QQ 邮箱完成验证后重试。');
    const sid = text(data.sid);
    if (!sid) throw new MailFailure('auth', '邮箱尚未开通或需要完成额外验证。');
    signal?.throwIfAborted();
    if (this.disposed || this.onlinePid() !== pid)
      throw new MailFailure('auth', 'QQ 账号状态已变化，请重新连接邮箱。');
    this.sid = sid;
    this.lastValidated = Date.now();
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
      json(await this.transport.request(`${MAIL_ORIGIN}/qs/list_notify?f=json`, { signal })),
    );
  }

  async downloadCredentials(
    source: URL,
    big: boolean,
    signal?: AbortSignal,
  ): Promise<{ url: URL; cookie: string }> {
    await this.connect(signal);
    let url = new URL(source);
    if (url.origin !== MAIL_ORIGIN && url.origin !== 'https://mail.qq.com')
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
    const cookie =
      url.origin === MAIL_ORIGIN || url.origin === 'https://mail.qq.com'
        ? await this.transport.jar.getCookieString(url.href)
        : '';
    return { url, cookie };
  }

  async redact(html: string): Promise<string> {
    const cookies = [
      ...(await this.transport.jar.getCookies(`${MAIL_ORIGIN}/`)),
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
    this.transport.dispose();
  }
}
