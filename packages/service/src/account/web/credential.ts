/**
 * Credential plumbing for the qq.com web cgi layer.
 *
 * Every QQ web cgi (qun.qq.com / h5.qzone.qq.com / web.qun.qq.com) authenticates
 * with a cookie jar (skey + p_skey + uin) plus a `bkn`/`g_tk` csrf token derived
 * from one of those keys. We don't run the ptlogin2 jump in TS — the native
 * `fetchSkey` / `fetchPskey` already swap the account's clientKey for those keys
 * (see nt_helper). This module only:
 *
 *   1. computes the bkn hash in TS (so a wrong token is easy to spot/debug), and
 *   2. assembles the cookie header from the native-supplied keys.
 *
 * `fetchSkey(pid, uin)`        → raw skey string (domain-independent).
 * `fetchPskey(pid, uin, dom)`  → raw p_skey string for `dom`.
 */

import type { NtHelperBinding } from '@weq/native';
import { getLogger, logErrorContext } from '../../common/logger';
import { fetchPtlogin2Jar, parseClientKeyJson } from './ptlogin';

/**
 * djb2 hash → 31-bit `bkn` (a.k.a. `g_tk` / csrf token), QQ-web style.
 * Mirrors native `computeBkn`; kept in TS so token mismatches surface here
 * rather than across the napi boundary.
 */
export function computeBkn(key: string): number {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash += (hash << 5) + key.charCodeAt(i);
  }
  return hash & 0x7fffffff;
}

/** The per-account tokens a web cgi needs, before they're joined into a header. */
export interface WebCredential {
  /** Raw uin, WITHOUT the leading 'o' (query params want it bare). */
  uin: string;
  /** ptlogin2 skey. */
  skey: string;
  /** p_skey for the target domain. May be empty if only skey was obtainable. */
  pskey: string;
  /**
   * Full cookie-jar header harvested via the ptlogin2 jump (含 pt4_token/RK/ptcz
   * 等风控 cookie)。存在时 {@link cookieHeader} 优先发它 —— 手拼的 4 字段会被
   * QZone 风控甩 `-10000`。拿不到时为空,回退到 4 字段拼装。
   */
  cookie?: string;
}

/**
 * Assemble the `Cookie` header a qq.com web cgi expects. 优先用 ptlogin2 jump 收到
 * 的完整 jar(`cred.cookie`);没有时回退到 `uin/skey/p_uin/p_skey` 四字段拼装。
 * `uin` / `p_uin` carry the conventional 'o' prefix; empty tokens are dropped.
 */
export function cookieHeader(cred: WebCredential): string {
  if (cred.cookie) return cred.cookie;
  const jar: Record<string, string> = {
    uin: `o${cred.uin}`,
    skey: cred.skey,
    p_uin: `o${cred.uin}`,
    p_skey: cred.pskey,
  };
  return Object.entries(jar)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/** Minimal native surface the web layer needs — key fetchers + clientKey + pt_login fallback. */
export type WebNative = Pick<
  NtHelperBinding,
  | 'fetchSkey'
  | 'fetchPskey'
  | 'fetchClientKey'
  | 'probePtLoginPort'
  | 'ptFetchSkey'
  | 'ptFetchPskey'
>;

/**
 * pt_login（本地快速登录）已验证可用的业务域。ti.qq.com（互动标识）与
 * weiyun.com（我的收藏）没有可用的 appid/daid，native 侧不支持，不在列表内。
 */
export const PT_LOGIN_DOMAINS: ReadonlySet<string> = new Set([
  'qun.qq.com',
  'qzone.qq.com',
  'pd.qq.com',
  'vip.qq.com',
]);

/** 探测 QQ 进程的 pt_login 端口（奇数 = HTTPS，偶数 = HTTP）；失败抛错。 */
export async function probePtLoginPort(nt: WebNative, pid: number): Promise<number> {
  const probe = nt.probePtLoginPort(pid);
  if (!probe.success) throw new Error(`pt_login 端口不可用：${probe.msg}`);
  return probe.port;
}

/** 通过 ptlogin2 本地快速登录获取 skey（无需注入 hook）；失败抛错。 */
export async function fetchSkeyViaPtLogin(
  nt: WebNative,
  pid: number,
  uin: string,
): Promise<string> {
  const port = await probePtLoginPort(nt, pid);
  const res = await nt.ptFetchSkey(port, uin);
  if (!res.success || !res.skey) throw new Error(`pt_login 获取 skey 失败：${res.msg}`);
  return res.skey;
}

/** 通过 ptlogin2 本地快速登录获取指定域 p_skey（无需注入 hook）；失败抛错。 */
export async function fetchPskeyViaPtLogin(
  nt: WebNative,
  pid: number,
  uin: string,
  domain: string,
): Promise<string> {
  const port = await probePtLoginPort(nt, pid);
  const res = await nt.ptFetchPskey(port, uin, domain);
  if (!res.success || !res.pskey)
    throw new Error(`pt_login 获取 ${domain} p_skey 失败：${res.msg}`);
  return res.pskey;
}

/** 窗口自动登录用的一次性 skey / p_skey。hook 优先，pt_login 兜底。 */
export interface WebTokens {
  skey: string;
  pskey: string;
}

/**
 * 取某个在线 QQ 进程的 skey / p_skey（用于窗口自动登录等一次性场景）。
 * 已注入时走 native fetch（秒回）；未注入 / 完全离线模式回退 ptlogin2 本地快速登录。
 * 仅支持 PT_LOGIN_DOMAINS；任一步失败返回空串，不抛错。
 */
export async function fetchWebTokens(
  nt: WebNative,
  uin: string,
  pid: number,
  domain: string,
  opts: { needSkey?: boolean } = {},
): Promise<WebTokens> {
  if (!PT_LOGIN_DOMAINS.has(domain)) return { skey: '', pskey: '' };
  try {
    const skey = opts.needSkey ? await nt.fetchSkey(pid, uin) : '';
    const pskey = await nt.fetchPskey(pid, uin, domain);
    if (pskey && (opts.needSkey ? skey : true)) return { skey, pskey };
  } catch {
    /* 未注入 / 注入掉了 → 走 pt_login 兜底 */
  }
  try {
    const skey = opts.needSkey ? await fetchSkeyViaPtLogin(nt, pid, uin) : '';
    const pskey = await fetchPskeyViaPtLogin(nt, pid, uin, domain);
    return { skey, pskey };
  } catch {
    return { skey: '', pskey: '' };
  }
}

/**
 * Resolves {@link WebCredential}s on demand from a hook-injected QQ process.
 *
 * skey is fetched once and cached (it's domain-independent); p_skey is cached
 * per-domain. Both are short-lived server-side, so a cached bundle can go stale
 * while the provider is still alive — long-lived holders (see `WebQueryService`,
 * which lives for the whole account session) must call {@link invalidate} when a
 * cgi rejects the credentials, then retry. {@link withRetry} wraps that loop.
 *
 * We deliberately do NOT expire on a timer: p_skey's real server-side TTL isn't
 * documented anywhere we trust, and a wrong guess either wastes hook round-trips
 * or leaves the stale window open. Letting the cgi tell us is exact.
 *
 * `resolvePid` is called on every fetch so the provider tolerates the account's
 * QQ.exe being restarted (caller hands back the current pid).
 */
export class WebCredentialProvider {
  private skey: string | null = null;
  private readonly pskeyByDomain = new Map<string, string>();
  private readonly cookieByDomain = new Map<string, string>();
  private readonly seededDomains = new Set<string>();
  private readonly logger;

  constructor(
    private readonly nt: WebNative,
    private readonly uin: string,
    private readonly resolvePid: () => number,
  ) {
    this.logger = getLogger().child({ scope: 'web-credential', accountUin: this.uin });
  }

  /**
   * Pre-load p_skey harvested elsewhere (e.g. by the ninebird login loader,
   * which grabs it while QQ is still up). Saves a hook round-trip, and works
   * even after the login process is gone.
   */
  seedPskey(byDomain: Record<string, string>): void {
    for (const [domain, pskey] of Object.entries(byDomain)) {
      if (pskey) {
        this.pskeyByDomain.set(domain, pskey);
        this.seededDomains.add(domain);
      }
    }
  }

  /**
   * Drop the cached tokens for `domain` so the next {@link forDomain} re-mints
   * them. Call this when a cgi rejects the credentials — see {@link withRetry}.
   *
   * skey is cleared too: it's domain-independent, so a rejection on any domain
   * is evidence it went stale, and re-fetching it is one cheap hook round-trip.
   *
   * The seeded p_skey (harvested at login, possibly hours ago) is the most
   * likely thing to be stale, and once seeded it short-circuits the live hook
   * path — so dropping it here is what actually unblocks the retry.
   */
  invalidate(domain: string): void {
    this.logger.info('invalidating cached web credential', {
      event: 'invalidate-web-credential',
      domain,
      wasSeeded: this.seededDomains.has(domain),
    });
    this.skey = null;
    this.pskeyByDomain.delete(domain);
    this.cookieByDomain.delete(domain);
    this.seededDomains.delete(domain);
  }

  /** Credential bundle for `domain` (e.g. 'qun.qq.com', 'qzone.qq.com'). */
  async forDomain(domain: string): Promise<WebCredential> {
    const pid = this.resolvePid();
    this.logger.info('resolving web credential', {
      event: 'resolve-web-credential',
      pid,
      domain,
      hasSkeyCache: this.skey !== null,
      hasPskeyCache: this.pskeyByDomain.has(domain),
      hasCookieCache: this.cookieByDomain.has(domain),
    });

    try {
      // 主路径:用 clientKey 打 ptlogin2 jump,收一整套 cookie jar(含 pt4_token/
      // RK/ptcz 等风控 cookie)。失败不致命 —— 回退到 native skey/p_skey 四字段。
      const jar = await this.harvestJar(pid, domain);

      // skey / p_skey:优先用 jar 里的,jar 没有就回退 native(OIDB)。两个 fetcher
      // 都走同一条 hook pipe,顺序调用避免争用。
      //
      // 已 seed p_skey 时 skey 允许缺失:seed 的场景是「QQ 已退出、只剩登录时收下的
      // 票据」,此时 fetchSkey 必然打不通 hook。只认 p_skey 的 cgi(如 vip.qq.com 的
      // GetNewStyleAppUsing)照样能跑,故这里降级而非整体失败。
      let skey = jar.skey ?? this.skey ?? undefined;
      if (!skey) {
        try {
          skey = await this.nt.fetchSkey(pid, this.uin);
          this.logger.info('fetched skey', { event: 'fetch-skey', pid, domain });
        } catch (hookError) {
          // hook 不可用（未注入 / 注入掉了 / 完全离线模式）→ ptlogin2 本地快速登录兜底。
          skey = await this.fetchSkeyWithFallback(pid, domain, hookError);
        }
      }
      this.skey = skey;

      let pskey = jar.p_skey ?? this.pskeyByDomain.get(domain);
      if (pskey === undefined) {
        try {
          pskey = await this.nt.fetchPskey(pid, this.uin, domain);
          this.logger.info('fetched pskey', { event: 'fetch-pskey', pid, domain });
        } catch (hookError) {
          // 未注入拿不到 p_skey → 回退 ptlogin2 本地快速登录（仅支持已验证的四域）。
          if (!PT_LOGIN_DOMAINS.has(domain)) throw hookError;
          pskey = await fetchPskeyViaPtLogin(this.nt, pid, this.uin, domain);
          this.logger.info('fetched pskey via pt_login', {
            event: 'fetch-pskey-ptlogin',
            pid,
            domain,
          });
        }
      }
      this.pskeyByDomain.set(domain, pskey);

      // 把回退补来的值并回 jar,拼成完整 cookie 头。jar 为空(ptlogin2 失败)时
      // cookie 退化成 4 字段,等价旧行为。
      jar.uin = jar.uin || `o${this.uin}`;
      jar.p_uin = jar.p_uin || `o${this.uin}`;
      jar.skey = jar.skey || skey;
      if (pskey) jar.p_skey = jar.p_skey || pskey;
      const cookie = Object.entries(jar)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');

      return { uin: this.uin, skey, pskey, cookie };
    } catch (error) {
      this.logger.error('failed to resolve web credential', {
        event: 'resolve-web-credential-failed',
        pid,
        domain,
        ...logErrorContext(error),
      });
      throw error;
    }
  }

  /**
   * skey 的 pt_login 兜底。仅支持 PT_LOGIN_DOMAINS 内的域；拿到 seed p_skey
   * 时可容忍 skey 缺失（降级为 ""），否则抛错。
   */
  private async fetchSkeyWithFallback(
    pid: number,
    domain: string,
    hookError: unknown,
  ): Promise<string> {
    if (!PT_LOGIN_DOMAINS.has(domain)) {
      if (this.pskeyByDomain.has(domain)) {
        this.logger.warn('fetchSkey failed; continuing with seeded p_skey only', {
          event: 'fetch-skey-failed-seeded',
          pid,
          domain,
          ...logErrorContext(hookError),
        });
        return '';
      }
      throw hookError;
    }
    try {
      const skey = await fetchSkeyViaPtLogin(this.nt, pid, this.uin);
      this.logger.info('fetched skey via pt_login', {
        event: 'fetch-skey-ptlogin',
        pid,
        domain,
      });
      return skey;
    } catch (fallbackError) {
      if (this.pskeyByDomain.has(domain)) {
        this.logger.warn('pt_login skey failed; continuing with seeded p_skey only', {
          event: 'fetch-skey-failed-seeded-ptlogin',
          pid,
          domain,
          ...logErrorContext(fallbackError),
        });
        return '';
      }
      throw fallbackError;
    }
  }

  /**
   * ptlogin2 jump 拿 `domain` 的完整 cookie jar(按域缓存)。clientKey 取不到 / 跳转
   * 失败时返回空对象 —— 调用方会回退到 native skey/p_skey,不让风控 cookie 缺失成为
   * 致命错误(也兼容完全离线模式、自动注入 QQ 关闭的账号)。
   */
  private async harvestJar(pid: number, domain: string): Promise<Record<string, string>> {
    const cached = this.cookieByDomain.get(domain);
    if (cached) return parseCookieHeader(cached);

    try {
      const ck = parseClientKeyJson(await this.nt.fetchClientKey(pid));
      if (!ck) {
        this.logger.warn('clientKey unavailable — falling back to skey/p_skey cookie', {
          event: 'harvest-jar-no-clientkey',
          pid,
          domain,
        });
        return {};
      }
      const jar = await fetchPtlogin2Jar(ck, this.uin, domain);
      this.cookieByDomain.set(
        domain,
        Object.entries(jar)
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      );
      this.logger.info('harvested ptlogin2 cookie jar', {
        event: 'harvest-jar',
        pid,
        domain,
        cookieKeys: Object.keys(jar).length,
        hasPskey: Boolean(jar.p_skey),
        hasPt4Token: Boolean(jar.pt4_token),
      });
      return jar;
    } catch (error) {
      this.logger.warn('ptlogin2 jump failed — falling back to skey/p_skey cookie', {
        event: 'harvest-jar-failed',
        pid,
        domain,
        ...logErrorContext(error),
      });
      return {};
    }
  }
}

/** Split a `k=v; k=v` cookie header back into a jar (for cache rehydration). */
function parseCookieHeader(header: string): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) jar[k] = v;
  }
  return jar;
}

/**
 * Thrown by a cgi wrapper when the response says "these credentials are no
 * good". {@link withRetry} catches exactly this to decide a retry is worth it —
 * a parse failure or a 500 would not be.
 *
 * QQ's web cgis signal this with an HTTP **200** plus an error code in the body
 * (-3000 / -10000 / 光 message), so every caller has to check its own body
 * shape; there's no shared status-code path that could do it for them.
 */
export class WebAuthError extends Error {
  constructor(
    message: string,
    /** The cgi's own code, for logs. */
    readonly code?: number,
  ) {
    super(message);
    this.name = 'WebAuthError';
  }
}

/**
 * Run `fn` with credentials for `domain`; if it throws {@link WebAuthError},
 * drop the cached tokens and run it once more with freshly-minted ones.
 *
 * One retry, not a loop: if newly-minted credentials are also rejected then the
 * problem isn't staleness (QQ logged out, risk control, no permission) and
 * hammering the hook won't fix it.
 */
export async function withRetry<T>(
  creds: WebCredentialProvider,
  domain: string,
  fn: (cred: WebCredential) => Promise<T>,
): Promise<T> {
  try {
    return await fn(await creds.forDomain(domain));
  } catch (e) {
    if (!(e instanceof WebAuthError)) throw e;
    creds.invalidate(domain);
    return fn(await creds.forDomain(domain));
  }
}
