/**
 * Credential plumbing for the qq.com web cgi layer.
 *
 * 凭据获取本身（ptlogin2 / clientKey jump / OIDB 0x102a_0 兜底）**只在
 * nt_helper 里实现一份**，这里只负责：
 *
 *   1. 按域缓存 native 返回的凭据；
 *   2. 计算 `bkn` / `g_tk`；
 *   3. 把 skey / p_skey / Cookie 拼成 cgi 需要的头。
 */

import type { NtHelperBinding } from '@weq/native';
import { getLogger, logErrorContext } from '../../common/logger';

/**
 * djb2 hash → 31-bit `bkn` (a.k.a. `g_tk` / csrf token), QQ-web style.
 * Sole implementation — the former native copy was removed together with the
 * rest of `nt_helper/src/protocol/service`.
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

/** Minimal native surface the web layer needs. */
export type WebNative = Pick<NtHelperBinding, 'ptFetchCredentials'>;

/** 窗口自动登录用的一次性 skey / p_skey。hook 优先，pt_login 兜底。 */
export interface WebTokens {
  skey: string;
  pskey: string;
}

/**
 * 取某个在线 QQ 进程的 skey / p_skey（用于窗口自动登录等一次性场景）。
 * 实际换取逻辑在 native `ptFetchCredentials`；失败返回空串，不抛错。
 * `seedPskey`（可选）：登录时收下的该域 p_skey，在 native 也拿不到时兜底。
 */
export async function fetchWebTokens(
  nt: WebNative,
  uin: string,
  pid: number,
  domain: string,
  opts: { needSkey?: boolean; seedPskey?: string } = {},
): Promise<WebTokens> {
  try {
    const res = await nt.ptFetchCredentials(pid, uin, domain);
    if (res.success && res.pskey) {
      return { skey: opts.needSkey ? res.skey : '', pskey: res.pskey };
    }
  } catch {
    /* native 拿不到（QQ 退出 / 未注入且探测端口失败）→ 退回登录收下的票据 */
  }
  // 登录时顺带收的 p_skey：可能已经过期，但总比空 jar 强，交给服务端判。
  // 只有 p_skey、没有 skey —— qzone.qq.com 的 g_tk 用 p_skey 就能算，够用。
  return { skey: '', pskey: opts.seedPskey ?? '' };
}

/**
 * Resolves {@link WebCredential}s on demand from a attached QQ process.
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
    /**
     * 登录时收下的 seed 票据被判失效时的回调（见 {@link invalidate}）。传进来的是
     * 「把落盘那份也删掉」的钩子（`AccountConfigService.clearLoginPskey`）；不传就只
     * 丢弃本实例的缓存，下次开账号还会 seed 一遍同样的死票据。
     */
    private readonly onSeedInvalidated?: (domain: string) => void,
  ) {
    this.logger = getLogger().child({ scope: 'web-credential', accountUin: this.uin });
  }

  /**
   * Pre-load p_skey harvested elsewhere (e.g. from a login flow that grabbed
   * it while QQ was still up). Saves a hook round-trip, and works even after
   * that process is gone.
   *
   * seed 进来的域会被记下来：cgi 判它失效时 {@link invalidate} 除了丢掉缓存，
   * 还会让落盘那份一起删掉（见 `onSeedInvalidated`）。
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
   *
   * 掉的是一个**登录时 seed 进来的**域时，还会通过 {@link onSeedInvalidated}
   * 让落盘那份也被删掉：否则下次开账号又会 seed 同一个死票据，每个域每次请求都先
   * 白失败一轮。
   */
  invalidate(domain: string): void {
    const wasSeeded = this.seededDomains.has(domain);
    this.logger.info('invalidating cached web credential', {
      event: 'invalidate-web-credential',
      domain,
      wasSeeded,
    });
    this.skey = null;
    this.pskeyByDomain.delete(domain);
    this.cookieByDomain.delete(domain);
    this.seededDomains.delete(domain);
    if (wasSeeded) this.dropSeededPskey(domain);
  }

  /**
   * 通知持有方（账号配置）把失效的 login p_skey 删掉。回调不该拖垮调用方 ——
   * `invalidate` 在错误路径上跑，落盘失败只记日志。
   */
  private dropSeededPskey(domain: string): void {
    if (!this.onSeedInvalidated) return;
    try {
      this.onSeedInvalidated(domain);
    } catch (error) {
      this.logger.warn('failed to drop invalid login pskey', {
        event: 'drop-seeded-pskey-failed',
        domain,
        ...logErrorContext(error),
      });
    }
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
      let skey = this.skey;
      let pskey = this.pskeyByDomain.get(domain);
      let cookie = this.cookieByDomain.get(domain);

      // 已有 p_skey（live 或登录时 seed）时不再要求 skey：离线只剩 seed 票据
      // 的场景仍能用 p_skey 算 g_tk，四字段 Cookie 也足够多数 cgi 使用。
      if (!pskey) {
        const res = await this.nt.ptFetchCredentials(pid, this.uin, domain);
        if (!res.success || !res.pskey) throw new Error(res.msg || '获取 Web 凭据失败');
        skey = res.skey;
        pskey = res.pskey;
        cookie = res.cookie || undefined;
        this.skey = skey;
        this.pskeyByDomain.set(domain, pskey);
        if (cookie) this.cookieByDomain.set(domain, cookie);
        this.logger.info('fetched web credential via native', {
          event: 'fetch-web-credential',
          pid,
          domain,
          hasSkey: Boolean(skey),
          hasCookie: Boolean(cookie),
        });
      }

      return {
        uin: this.uin,
        skey: skey ?? '',
        pskey,
        cookie: cookie ?? cookieHeader({ uin: this.uin, skey: skey ?? '', pskey }),
      };
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
