/**
 * Web 入口共用的会话鉴权，不依赖 Electron。
 *
 * Unlike the desktop shell, a browser-served WeQ can be reached by anything
 * that can open a TCP connection to it — and behind that gate sits the user's
 * entire QQ history. So the rule here is **deny by default**: every route
 * except the login page and the login endpoint requires a session cookie.
 *
 * Threat model / decisions:
 *   - Token compare is `timingSafeEqual` (constant-time) so an attacker can't
 *     walk the token out one byte at a time from response latency.
 *   - Failed attempts back off exponentially per-IP, so the token can't be
 *     brute-forced at line rate.
 *   - Binding to anything other than loopback REQUIRES an explicitly-set
 *     `WEQ_TOKEN`. Auto-generating one and printing it to a log nobody reads
 *     is how "I just wanted to try it on my LAN" turns into an open door.
 *   - Sessions live in memory only: a restart logs everyone out. That's a
 *     feature, not a gap — there's no session store to steal.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const SESSION_COOKIE = 'weq_session';
/** Sessions expire after this long without use. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Failed-attempt backoff: delay = BASE * 2^(fails-1), capped. */
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 30_000;
/** Drop a peer's failure record after this long with no attempts. */
const FAIL_RESET_MS = 60 * 60 * 1000;

export const AUTH_RESOURCE_LIMITS = {
  sessionTtlMs: SESSION_TTL_MS,
  failureTtlMs: FAIL_RESET_MS,
  maxBackoffMs: BACKOFF_MAX_MS,
  backoffBaseMs: BACKOFF_BASE_MS,
  sweepMs: 60_000,
  maxSessions: 4096,
  maxFailureRecords: 4096,
  maxPendingLogins: 256,
} as const;

/** 资源不足不是密码错误；HTTP 层以 503 明确提示稍后重试。 */
export class AuthUnavailableError extends Error {}

function positiveLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('认证容量必须是正整数');
  return limit;
}

export interface AuthConfig {
  maxSessions?: number;
  maxFailureRecords?: number;
  maxPendingLogins?: number;
  /** The shared secret a client must present to log in. */
  token: string;
  /** True when the server binds beyond loopback (enables Secure cookie). */
  remote: boolean;
}

interface Session {
  expiresAt: number;
  listeners?: Set<() => void>;
  timer?: NodeJS.Timeout;
}

interface FailRecord {
  count: number;
  lastAt: number;
}

export class AuthGate {
  private readonly maxSessions: number;
  private readonly maxFailureRecords: number;
  private readonly maxPendingLogins: number;
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly lifecycle = new AbortController();
  private closed = false;
  private pendingLogins = 0;
  private overflowLastAt: number | undefined;
  private readonly tokenBuf: Buffer;
  private readonly remote: boolean;
  private readonly sessions = new Map<string, Session>();
  private readonly fails = new Map<string, FailRecord>();

  constructor(config: AuthConfig) {
    this.maxSessions = positiveLimit(config.maxSessions, AUTH_RESOURCE_LIMITS.maxSessions);
    this.maxFailureRecords = positiveLimit(
      config.maxFailureRecords,
      AUTH_RESOURCE_LIMITS.maxFailureRecords,
    );
    this.maxPendingLogins = positiveLimit(
      config.maxPendingLogins,
      AUTH_RESOURCE_LIMITS.maxPendingLogins,
    );
    this.tokenBuf = Buffer.from(config.token, 'utf8');
    this.remote = config.remote;
    this.cleanupTimer = setInterval(() => this.prune(), AUTH_RESOURCE_LIMITS.sweepMs);
    this.cleanupTimer.unref();
  }

  /** 仅返回资源数量，不暴露 sid、来源地址或凭据。 */
  diagnostics() {
    return {
      sessions: this.sessions.size,
      failureRecords: this.fails.size,
      pendingLogins: this.pendingLogins,
      overflowActive: this.overflowActive(),
    };
  }

  private overflowActive(): boolean {
    return this.overflowLastAt !== undefined && Date.now() - this.overflowLastAt <= FAIL_RESET_MS;
  }

  private prune(): void {
    const now = Date.now();
    for (const [sid, session] of this.sessions) if (session.expiresAt <= now) this.revoke(sid);
    for (const [peer, rec] of this.fails)
      if (now - rec.lastAt > FAIL_RESET_MS) this.fails.delete(peer);
    if (!this.overflowActive()) this.overflowLastAt = undefined;
  }

  /**
   * Constant-time token check. Length is compared separately because
   * `timingSafeEqual` throws on a length mismatch — but length alone is a
   * negligible leak next to byte-by-byte content timing.
   */
  private tokenMatches(candidate: string): boolean {
    const buf = Buffer.from(candidate, 'utf8');
    if (buf.length !== this.tokenBuf.length) return false;
    return timingSafeEqual(buf, this.tokenBuf);
  }

  /** Milliseconds to stall before answering a login from `peer`. */
  private backoffFor(peer: string): number {
    const rec = this.fails.get(peer);
    if (rec) {
      if (Date.now() - rec.lastAt <= FAIL_RESET_MS)
        return Math.min(BACKOFF_BASE_MS * 2 ** (rec.count - 1), BACKOFF_MAX_MS);
      this.fails.delete(peer);
    }
    // 不淘汰仍生效的失败记录；未知来源共用保守退避，换地址不能重新获得免费尝试。
    return this.overflowActive() || this.fails.size >= this.maxFailureRecords ? BACKOFF_MAX_MS : 0;
  }

  private noteFailure(peer: string): void {
    const rec = this.fails.get(peer);
    if (!rec && (this.fails.size >= this.maxFailureRecords || this.overflowActive())) {
      this.overflowLastAt = Date.now();
      return;
    }
    this.fails.set(peer, { count: Math.min((rec?.count ?? 0) + 1, 32), lastAt: Date.now() });
  }

  private waitBackoff(ms: number): Promise<void> {
    const signal = this.lifecycle.signal;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, ms);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  /**
   * Validate a login attempt. Resolves true and sets the session cookie on
   * success. Always waits out the current backoff first, so a wrong token
   * costs the caller real time.
   */
  async login(token: string, peer: string, res: ServerResponse): Promise<boolean> {
    if (this.closed) throw new AuthUnavailableError('认证服务已关闭');
    if (this.pendingLogins >= this.maxPendingLogins)
      throw new AuthUnavailableError('认证服务繁忙，请稍后重试');
    this.pendingLogins++;
    try {
      this.prune();
      const delay = this.backoffFor(peer);
      if (delay > 0) await this.waitBackoff(delay);
      if (this.closed) throw new AuthUnavailableError('认证服务已关闭');

      if (!this.tokenMatches(token)) {
        this.noteFailure(peer);
        return false;
      }

      this.fails.delete(peer);
      this.prune();
      if (this.sessions.size >= this.maxSessions)
        throw new AuthUnavailableError('登录会话容量已满，请稍后重试');
      const sid = randomBytes(32).toString('base64url');
      this.sessions.set(sid, { expiresAt: Date.now() + SESSION_TTL_MS });

      const attrs = [
        `${SESSION_COOKIE}=${sid}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ];
      // Secure would make the cookie unusable over plain http on loopback, which
      // is the normal local case. Only set it when we're actually exposed.
      if (this.remote) attrs.push('Secure');
      res.setHeader('Set-Cookie', attrs.join('; '));
      return true;
    } catch (error) {
      if (this.closed) throw new AuthUnavailableError('认证服务已关闭');
      throw error;
    } finally {
      this.pendingLogins--;
    }
  }

  /** True when the request carries a live session cookie. Refreshes its TTL. */
  isAuthed(req: IncomingMessage): boolean {
    const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!sid) return false;
    const session = this.sessions.get(sid);
    if (!session) return false;
    if (session.expiresAt <= Date.now()) {
      this.revoke(sid);
      return false;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    this.scheduleExpiry(sid, session);
    return true;
  }

  /** Long-lived transports must be disconnected on logout and idle expiry. */
  watchSession(req: IncomingMessage, onRevoke: () => void): () => void {
    const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
    const session = sid ? this.sessions.get(sid) : undefined;
    if (!sid || !session || session.expiresAt <= Date.now()) {
      if (sid) this.revoke(sid);
      onRevoke();
      return () => {};
    }
    session.listeners ??= new Set();
    session.listeners.add(onRevoke);
    this.scheduleExpiry(sid, session);
    return () => {
      session.listeners?.delete(onRevoke);
      if (!session.listeners?.size && session.timer) {
        clearTimeout(session.timer);
        session.timer = undefined;
      }
    };
  }

  private scheduleExpiry(sid: string, session: Session): void {
    if (!session.listeners?.size) return;
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => this.revoke(sid), Math.max(0, session.expiresAt - Date.now()));
    session.timer.unref();
  }

  private revoke(sid: string): void {
    const session = this.sessions.get(sid);
    this.sessions.delete(sid);
    if (session?.timer) clearTimeout(session.timer);
    for (const listener of session?.listeners ?? []) {
      try {
        listener();
      } catch {
        console.error('Web 会话失效监听器执行失败');
      }
    }
    session?.listeners?.clear();
  }

  /** Drop the caller's session and clear the cookie. */
  logout(req: IncomingMessage, res: ServerResponse): void {
    const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (sid) this.revoke(sid);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.cleanupTimer);
    this.lifecycle.abort();
    for (const sid of this.sessions.keys()) this.revoke(sid);
    this.fails.clear();
    this.overflowLastAt = undefined;
  }
}

/** Read one cookie value out of a `Cookie:` header. */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Stable per-peer key for backoff bookkeeping. */
export function peerKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}
