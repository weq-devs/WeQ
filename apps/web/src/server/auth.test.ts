/**
 * Auth gate tests — run with `npx tsx apps/web/src/server/auth.test.ts`.
 *
 * This is the one component where a bug means "anyone on the network can read
 * the user's entire QQ history", so the behaviour is pinned down explicitly.
 */

import { AuthGate } from './auth';
import type { IncomingMessage, ServerResponse } from 'node:http';

let failed = 0;
function check(ok: boolean, label: string): void {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

/** Minimal ServerResponse stand-in that records Set-Cookie. */
function fakeRes(): ServerResponse & { cookie: string | null } {
  const headers: Record<string, string> = {};
  return {
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    get cookie() {
      return headers['set-cookie'] ?? null;
    },
  } as unknown as ServerResponse & { cookie: string | null };
}

function fakeReq(cookie?: string, ip = '1.2.3.4'): IncomingMessage {
  return {
    headers: cookie ? { cookie } : {},
    socket: { remoteAddress: ip },
  } as unknown as IncomingMessage;
}

/** Pull `weq_session=...` out of a Set-Cookie header into a Cookie header. */
function cookieHeader(setCookie: string | null): string {
  return (setCookie ?? '').split(';')[0] ?? '';
}

async function main(): Promise<void> {
  // ---- happy path ----
  {
    const gate = new AuthGate({ token: 'correct-horse', remote: false });
    const res = fakeRes();
    const ok = await gate.login('correct-horse', '1.1.1.1', res);
    check(ok, 'correct token → login succeeds');
    check(res.cookie !== null, 'login sets a cookie');
    check(res.cookie!.includes('HttpOnly'), 'cookie is HttpOnly');
    check(res.cookie!.includes('SameSite=Strict'), 'cookie is SameSite=Strict');
    check(!res.cookie!.includes('Secure'), 'loopback → no Secure flag');
    check(gate.isAuthed(fakeReq(cookieHeader(res.cookie))), 'session cookie authenticates');
  }

  // ---- rejection ----
  {
    const gate = new AuthGate({ token: 'correct-horse', remote: false });
    const res = fakeRes();
    check(!(await gate.login('wrong', '2.2.2.2', res)), 'wrong token → rejected');
    check(res.cookie === null, 'failed login sets no cookie');
    check(!gate.isAuthed(fakeReq()), 'no cookie → not authed');
    check(!gate.isAuthed(fakeReq('weq_session=forged')), 'forged session id → not authed');
    check(
      !(await gate.login('correct-horse-longer', '2.2.2.2', fakeRes())),
      'longer token with correct prefix → rejected',
    );
    check(!(await gate.login('', '2.2.2.2', fakeRes())), 'empty token → rejected');
  }

  // ---- remote hardening ----
  {
    const gate = new AuthGate({ token: 'tok', remote: true });
    const res = fakeRes();
    await gate.login('tok', '3.3.3.3', res);
    check(res.cookie!.includes('Secure'), 'remote bind → Secure flag set');
  }

  // ---- backoff ----
  {
    const gate = new AuthGate({ token: 'tok', remote: false });
    const peer = '4.4.4.4';
    // First failure is immediate; subsequent ones must stall progressively.
    await gate.login('nope', peer, fakeRes());
    const t0 = Date.now();
    await gate.login('nope', peer, fakeRes());
    const firstDelay = Date.now() - t0;
    const t1 = Date.now();
    await gate.login('nope', peer, fakeRes());
    const secondDelay = Date.now() - t1;
    check(firstDelay >= 200, `2nd failure stalls (${firstDelay}ms)`);
    check(secondDelay > firstDelay, `3rd failure stalls longer (${secondDelay}ms)`);

    // A different peer is unaffected by this one's failures.
    const t2 = Date.now();
    await gate.login('nope', '5.5.5.5', fakeRes());
    check(Date.now() - t2 < 100, 'backoff is per-peer, not global');

    // Correct token still works (after paying the accrued backoff) and resets.
    const res = fakeRes();
    check(await gate.login('tok', peer, res), 'correct token still accepted after failures');
    const t3 = Date.now();
    await gate.login('nope', peer, fakeRes());
    check(Date.now() - t3 < 100, 'successful login clears the backoff');
  }

  // ---- logout ----
  {
    const gate = new AuthGate({ token: 'tok', remote: false });
    const res = fakeRes();
    await gate.login('tok', '6.6.6.6', res);
    const cookie = cookieHeader(res.cookie);
    check(gate.isAuthed(fakeReq(cookie)), 'authed before logout');
    const out = fakeRes();
    gate.logout(fakeReq(cookie), out);
    check(!gate.isAuthed(fakeReq(cookie)), 'session dead after logout');
    check(out.cookie!.includes('Max-Age=0'), 'logout clears the cookie');
  }

  // ---- session isolation ----
  {
    const gate = new AuthGate({ token: 'tok', remote: false });
    const a = fakeRes();
    const b = fakeRes();
    await gate.login('tok', '7.7.7.7', a);
    await gate.login('tok', '8.8.8.8', b);
    check(cookieHeader(a.cookie) !== cookieHeader(b.cookie), 'each login gets a distinct session');
    gate.logout(fakeReq(cookieHeader(a.cookie)), fakeRes());
    check(gate.isAuthed(fakeReq(cookieHeader(b.cookie))), "one logout doesn't kill other sessions");
  }

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
