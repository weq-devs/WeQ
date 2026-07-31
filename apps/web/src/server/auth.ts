/**
 * Auth gate for the web app.
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

export interface AuthConfig {
  /** The shared secret a client must present to log in. */
  token: string;
  /** True when the server binds beyond loopback (enables Secure cookie). */
  remote: boolean;
}

interface Session {
  expiresAt: number;
}

interface FailRecord {
  count: number;
  lastAt: number;
}

export class AuthGate {
  private readonly tokenBuf: Buffer;
  private readonly remote: boolean;
  private readonly sessions = new Map<string, Session>();
  private readonly fails = new Map<string, FailRecord>();

  constructor(config: AuthConfig) {
    this.tokenBuf = Buffer.from(config.token, 'utf8');
    this.remote = config.remote;
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
    if (!rec) return 0;
    if (Date.now() - rec.lastAt > FAIL_RESET_MS) {
      this.fails.delete(peer);
      return 0;
    }
    return Math.min(BACKOFF_BASE_MS * 2 ** (rec.count - 1), BACKOFF_MAX_MS);
  }

  private noteFailure(peer: string): void {
    const rec = this.fails.get(peer);
    this.fails.set(peer, { count: (rec?.count ?? 0) + 1, lastAt: Date.now() });
  }

  /**
   * Validate a login attempt. Resolves true and sets the session cookie on
   * success. Always waits out the current backoff first, so a wrong token
   * costs the caller real time.
   */
  async login(token: string, peer: string, res: ServerResponse): Promise<boolean> {
    const delay = this.backoffFor(peer);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    if (!this.tokenMatches(token)) {
      this.noteFailure(peer);
      return false;
    }

    this.fails.delete(peer);
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
  }

  /** True when the request carries a live session cookie. Refreshes its TTL. */
  isAuthed(req: IncomingMessage): boolean {
    const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!sid) return false;
    const session = this.sessions.get(sid);
    if (!session) return false;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(sid);
      return false;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return true;
  }

  /** Drop the caller's session and clear the cookie. */
  logout(req: IncomingMessage, res: ServerResponse): void {
    const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (sid) this.sessions.delete(sid);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
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
