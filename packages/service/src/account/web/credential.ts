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
}

/**
 * Assemble the `Cookie` header a qq.com web cgi expects. `uin` / `p_uin` carry
 * the conventional 'o' prefix; empty tokens are dropped.
 */
export function cookieHeader(cred: WebCredential): string {
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

/** Minimal native surface the web layer needs — just the two key fetchers. */
export type WebNative = Pick<NtHelperBinding, 'fetchSkey' | 'fetchPskey'>;

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
    });

    // Sequential, not parallel: both fetchers drive OIDB over the same hook pipe
    // for this pid, so overlapping them risks contention.
    try {
      if (this.skey === null) {
        this.skey = await this.nt.fetchSkey(pid, this.uin);
        this.logger.info('fetched skey', { event: 'fetch-skey', pid, domain });
      }
      let pskey = this.pskeyByDomain.get(domain);
      if (pskey === undefined) {
        pskey = await this.nt.fetchPskey(pid, this.uin, domain);
        this.pskeyByDomain.set(domain, pskey);
        this.logger.info('fetched pskey', { event: 'fetch-pskey', pid, domain });
      }

      return { uin: this.uin, skey: this.skey, pskey };
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
}
