/**
 * End-to-end gate test: start the real HTTP server and prove that every route
 * is closed before login and open after. Unit-testing `AuthGate` isn't enough —
 * a routing mistake in `http.ts` (a route checked before the gate, a typo'd
 * prefix) would leave data exposed with the gate still passing its own tests.
 *
 * Run: npx tsx apps/web/src/server/http.test.ts
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthGate } from './auth';
import { startServer } from './http';

let failed = 0;
function check(ok: boolean, label: string): void {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

const TOKEN = 'test-token-abc';

async function main(): Promise<void> {
  const pub = mkdtempSync(join(tmpdir(), 'weq-web-'));
  writeFileSync(join(pub, 'index.html'), '<html>APP SHELL</html>');
  writeFileSync(join(pub, 'robots.txt'), 'secret-ish');

  let trpcHits = 0;
  const { server, port } = await startServer({
    port: 39871,
    host: '127.0.0.1',
    publicDir: pub,
    auth: new AuthGate({ token: TOKEN, remote: false }),
    trpc: (_req, res) => {
      trpcHits++;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('trpc-reached');
    },
  });

  const base = `http://127.0.0.1:${port}`;
  const get = (path: string, cookie?: string, accept = '*/*'): Promise<Response> =>
    fetch(base + path, {
      headers: cookie ? { cookie, accept } : { accept },
      redirect: 'manual',
    });

  // ---- everything is closed before login ----
  const guarded = ['/trpc/bootstrap.getVersionInfo', '/_media/pic?t=1&name=x',
    '/_avatar/fetch?src=http://x/', '/_asset/brand/logo.png', '/_download/anything',
    '/robots.txt', '/some/spa/route'];
  for (const path of guarded) {
    const res = await get(path);
    check(res.status === 401, `pre-auth ${path} → 401 (got ${res.status})`);
  }
  check(trpcHits === 0, 'tRPC handler never reached pre-auth');

  // A browser navigation gets the login form rather than a bare 401.
  {
    const res = await get('/', undefined, 'text/html');
    const body = await res.text();
    check(res.status === 200 && body.includes('访问令牌'), 'pre-auth HTML nav → login page');
    check(!body.includes('APP SHELL'), 'login page is not the app shell');
  }

  // ---- login ----
  const bad = await fetch(`${base}/_auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'nope' }),
  });
  check(bad.status === 401, 'login with wrong token → 401');
  check(bad.headers.get('set-cookie') === null, 'failed login sets no cookie');

  const good = await fetch(`${base}/_auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  check(good.status === 200, 'login with correct token → 200');
  const setCookie = good.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  check(cookie.startsWith('weq_session='), 'login returns a session cookie');

  // ---- routes open after login ----
  {
    const res = await get('/trpc/anything', cookie);
    check(res.status === 200 && (await res.text()) === 'trpc-reached', 'post-auth /trpc reaches router');
    check(trpcHits === 1, 'tRPC handler invoked exactly once');
  }
  {
    const res = await get('/robots.txt', cookie);
    check(res.status === 200 && (await res.text()) === 'secret-ish', 'post-auth static file served');
  }
  {
    const res = await get('/some/spa/route', cookie, 'text/html');
    check((await res.text()).includes('APP SHELL'), 'post-auth unknown route → SPA shell');
  }
  {
    const res = await get('/_download/bogus-id', cookie);
    check(res.status === 404, 'post-auth unknown download id → 404');
  }
  // Protocol routes reach their handlers (no account open → handler's own 4xx/5xx,
  // which is still proof the gate passed us through rather than a flat 401).
  {
    const res = await get('/_media/pic?t=1&name=x', cookie);
    check(res.status !== 401, `post-auth /_media reaches handler (got ${res.status})`);
  }

  // ---- a forged cookie stays out ----
  {
    const res = await get('/trpc/anything', 'weq_session=forged-value');
    check(res.status === 401, 'forged session cookie → 401');
  }

  // ---- logout closes the door again ----
  {
    await fetch(`${base}/_auth/logout`, { method: 'POST', headers: { cookie } });
    const res = await get('/trpc/anything', cookie);
    check(res.status === 401, 'after logout → 401 again');
  }

  server.close();
  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
