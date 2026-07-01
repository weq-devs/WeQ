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

/** Minimal native surface the web layer needs — key fetchers + clientKey. */
export type WebNative = Pick<NtHelperBinding, 'fetchSkey' | 'fetchPskey' | 'fetchClientKey'>;

/**
 * Resolves {@link WebCredential}s on demand from a hook-injected QQ process.
 *
 * skey is fetched once and cached (it's domain-independent); p_skey is cached
 * per-domain. Both are short-lived server-side, so callers that hold a provider
 * for a long time should construct a fresh one per logical operation — the
 * intended use is "make a provider, fire a query or two, drop it".
 *
 * `resolvePid` is called on every fetch so the provider tolerates the account's
 * QQ.exe being restarted (caller hands back the current pid).
 */
export class WebCredentialProvider {
  private skey: string | null = null;
  private readonly pskeyByDomain = new Map<string, string>();
  private readonly cookieByDomain = new Map<string, string>();
  private readonly logger;

  constructor(
    private readonly nt: WebNative,
    private readonly uin: string,
    private readonly resolvePid: () => number,
  ) {
    this.logger = getLogger().child({ scope: 'web-credential', accountUin: this.uin });
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
      let skey = jar['skey'] ?? this.skey ?? undefined;
      if (!skey) {
        skey = await this.nt.fetchSkey(pid, this.uin);
        this.logger.info('fetched skey', { event: 'fetch-skey', pid, domain });
      }
      this.skey = skey;

      let pskey = jar['p_skey'] ?? this.pskeyByDomain.get(domain);
      if (pskey === undefined) {
        pskey = await this.nt.fetchPskey(pid, this.uin, domain);
        this.logger.info('fetched pskey', { event: 'fetch-pskey', pid, domain });
      }
      this.pskeyByDomain.set(domain, pskey);

      // 把回退补来的值并回 jar,拼成完整 cookie 头。jar 为空(ptlogin2 失败)时
      // cookie 退化成 4 字段,等价旧行为。
      jar['uin'] = jar['uin'] || `o${this.uin}`;
      jar['p_uin'] = jar['p_uin'] || `o${this.uin}`;
      jar['skey'] = jar['skey'] || skey;
      if (pskey) jar['p_skey'] = jar['p_skey'] || pskey;
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
   * ptlogin2 jump 拿 `domain` 的完整 cookie jar(按域缓存)。clientKey 取不到 / 跳转
   * 失败时返回空对象 —— 调用方会回退到 native skey/p_skey,不让风控 cookie 缺失成为
   * 致命错误(也兼容关掉了「自动获取 ClientKey」的账号)。
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
        Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
      );
      this.logger.info('harvested ptlogin2 cookie jar', {
        event: 'harvest-jar',
        pid,
        domain,
        cookieKeys: Object.keys(jar).length,
        hasPskey: Boolean(jar['p_skey']),
        hasPt4Token: Boolean(jar['pt4_token']),
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
