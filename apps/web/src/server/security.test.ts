import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { observable } from '@trpc/server/observable';
import { procedure, router } from '../../../desktop/src/main/ipc/trpc';
import type { AppRouter } from '../../../desktop/src/main/ipc/router';
import { AuthGate } from './auth';
import { createWebHost } from './host';
import { attachWsHandler } from './trpc_adapter';

function response(onCookie: (cookie: string) => void = () => {}): ServerResponse {
  return {
    setHeader: (_name: string, value: string) => onCookie(value.split(';')[0]!),
  } as ServerResponse;
}

test('save targets reject POSIX and Windows path traversal without rejecting ordinary names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-web-save-boundary-'));
  try {
    const host = createWebHost({ exportDir: root, version: 'test' });
    for (const defaultName of [
      '../../../outside.html',
      '..\\..\\outside.html',
      '/tmp/outside',
      'C:\\outside',
      '.',
      '..',
      'bad\0name',
    ]) {
      await assert.rejects(host.pickSaveTarget({ defaultName, extension: 'html' }));
    }
    const target = await host.pickSaveTarget({ defaultName: 'report.html', extension: 'html' });
    assert.equal(dirname(target!.path), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('idle expiry revokes long-lived sessions, and only activity refreshes the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const auth = new AuthGate({ token: 'fixture', remote: false });
  let cookie = '';
  await auth.login(
    'fixture',
    'fixture',
    response((value) => {
      cookie = value;
    }),
  );
  const req = { headers: { cookie } } as IncomingMessage;
  let revoked = false;
  const unwatch = auth.watchSession(req, () => {
    revoked = true;
  });
  t.mock.timers.tick(11 * 60 * 60 * 1000);
  assert.equal(auth.isAuthed(req), true);
  t.mock.timers.tick(11 * 60 * 60 * 1000);
  assert.equal(revoked, false);
  t.mock.timers.tick(60 * 60 * 1000);
  assert.equal(revoked, true);
  assert.equal(auth.isAuthed(req), false);
  unwatch();
});

test('logout terminates only that session sockets, unsubscribes streams and blocks further RPCs', async () => {
  const auth = new AuthGate({ token: 'fixture', remote: false });
  async function login(): Promise<string> {
    let cookie = '';
    await auth.login(
      'fixture',
      'fixture',
      response((value) => {
        cookie = value;
      }),
    );
    return cookie;
  }
  const firstCookie = await login();
  const secondCookie = await login();
  let writes = 0;
  let unsubscribed = false;
  const app = router({
    write: procedure.mutation(() => ++writes),
    stream: procedure.subscription(() =>
      observable<string>(() => () => {
        unsubscribed = true;
      }),
    ),
  });
  const server = createServer((req, res) => {
    auth.logout(req, res);
    res.end('ok');
  });
  attachWsHandler(server, app as unknown as AppRouter, auth);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const url = `ws://127.0.0.1:${port}/trpc-ws`;
  const first = new WebSocket(url, { headers: { cookie: firstCookie } });
  const second = new WebSocket(url, { headers: { cookie: secondCookie } });
  try {
    await Promise.all([once(first, 'open'), once(second, 'open')]);
    const started = once(first, 'message');
    first.send(
      JSON.stringify({
        id: 1,
        method: 'subscription',
        params: { path: 'stream', input: { json: null } },
      }),
    );
    await started;
    const closed = once(first, 'close');
    await fetch(`http://127.0.0.1:${port}/logout`, {
      method: 'POST',
      headers: { cookie: firstCookie },
    });
    await closed;
    assert.equal(first.readyState, WebSocket.CLOSED);
    // tRPC 在 socket 关闭**之后**的下一个 tick 才调用 subscription 的 teardown，
    // 两个事件的先后顺序随平台 / 事件循环实现而变 —— 这里等它跑完再断言，
    // 而不是假设 close 时已经同步退订。
    for (let i = 0; i < 50 && !unsubscribed; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(unsubscribed, true);
    assert.equal(writes, 0);
    const reply = once(second, 'message');
    second.send(
      JSON.stringify({
        id: 2,
        method: 'mutation',
        params: { path: 'write', input: { json: null } },
      }),
    );
    await reply;
    assert.equal(writes, 1);
    assert.equal(second.readyState, WebSocket.OPEN);
    await assert.rejects(
      new Promise((resolve, reject) => {
        const rejected = new WebSocket(url, { headers: { cookie: firstCookie } });
        rejected.once('open', () => {
          rejected.terminate();
          resolve(undefined);
        });
        rejected.once('error', reject);
      }),
      /401/,
    );
  } finally {
    first.terminate();
    second.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('RPC middleware rechecks authorization on every call over a reused socket', async () => {
  const auth = new AuthGate({ token: 'fixture', remote: false });
  let cookie = '';
  await auth.login(
    'fixture',
    'fixture',
    response((value) => {
      cookie = value;
    }),
  );
  let allowed = true;
  const original = auth.isAuthed.bind(auth);
  auth.isAuthed = (req) => allowed && original(req);
  let reads = 0;
  const app = router({ read: procedure.query(() => ++reads) });
  const server = createServer();
  attachWsHandler(server, app as unknown as AppRouter, auth);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/trpc-ws`, { headers: { cookie } });
  try {
    await once(ws, 'open');
    const first = once(ws, 'message');
    ws.send(
      JSON.stringify({ id: 1, method: 'query', params: { path: 'read', input: { json: null } } }),
    );
    await first;
    allowed = false;
    const denied = once(ws, 'message');
    ws.send(
      JSON.stringify({ id: 2, method: 'query', params: { path: 'read', input: { json: null } } }),
    );
    const [raw] = await denied;
    assert.equal(JSON.parse(raw.toString()).error.json.data.code, 'UNAUTHORIZED');
    assert.equal(reads, 1);
  } finally {
    ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
