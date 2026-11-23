// @vitest-environment node
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  BROWSER_FILE_CHUNK_BYTES,
  PICKED_FILE_UPLOAD_PREFIX,
} from '../src/shared/browser_file_upload';
import { pickedBrowserFiles } from '../src/main/browser_files';
import { handleRequest } from '../src/main/web/http';

const state = vi.hoisted(() => ({ config: 'fixture', services: {} as object }));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    account: { context: { uin: '10001' } },
    services: state.services,
  }),
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  state.config = 'fixture';
  const owner = {
    accountConfig: { getRecord: () => ({ configId: state.config }) },
  };
  state.services = owner;
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, {
      publicDir: '.',
      trpc: () => {
        throw new Error('Unrelated RPC');
      },
      auth: {
        login: async () => false,
        logout: () => {},
        isAuthed: (input) => input.headers.cookie === 'session=fixture',
      },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { id } = await pickedBrowserFiles.start(owner, 5, 'fixture.jpg');
  cleanups.push(() => pickedBrowserFiles.discard(owner, id));
  const url = origin + PICKED_FILE_UPLOAD_PREFIX + id;
  const headers = {
    Cookie: 'session=fixture',
    'Content-Type': 'application/octet-stream',
    'X-WeQ-Upload-Offset': '0',
    'X-WeQ-Upload-Account': '10001',
    'X-WeQ-Upload-Source': 'fixture',
  };
  const send = (body: Uint8Array, patch: Record<string, string> = {}) =>
    fetch(url, { method: 'PUT', body, headers: { ...headers, ...patch } });
  return { owner, id, url, headers, send };
}

it('二进制附件分段在真实 HTTP 路由保留鉴权、来源、偏移和原始字节', async () => {
  const f = await fixture();
  expect((await f.send(Uint8Array.of(1), { Cookie: '' })).status).toBe(401);
  expect((await f.send(Uint8Array.of(1), { Origin: 'https://other.invalid' })).status).toBe(403);
  expect((await f.send(Uint8Array.of(1), { 'X-WeQ-Upload-Source': 'wrong' })).status).toBe(409);
  expect((await f.send(Uint8Array.of(1), { 'X-WeQ-Upload-Offset': '2' })).status).toBe(409);
  const head = await f.send(Uint8Array.of(0, 255, 120));
  expect(await head.json()).toEqual({ offset: 3 });
  const tail = await f.send(Uint8Array.of(5, 6), { 'X-WeQ-Upload-Offset': '3' });
  expect(await tail.json()).toEqual({ offset: 5 });
  expect(await readFile(pickedBrowserFiles.complete(f.owner, f.id))).toEqual(
    Buffer.from([0, 255, 120, 5, 6]),
  );
});

it('分段超限和正文未读完的连接中止不推进偏移，可从相同位置重传', async () => {
  const f = await fixture();
  const over = await f.send(new Uint8Array(BROWSER_FILE_CHUNK_BYTES + 1));
  expect(over.status).toBe(413);
  await over.body?.cancel();
  await new Promise<void>((resolve) => {
    const request = http.request(f.url, {
      method: 'PUT',
      headers: { ...f.headers, 'Content-Length': '5' },
    });
    request.on('error', () => undefined);
    request.on('close', () => resolve());
    request.write(Buffer.from([42]), () => request.destroy());
  });
  const retried = await f.send(Uint8Array.of(1, 2, 3, 4, 5));
  expect(await retried.json()).toEqual({ offset: 5 });
  expect(await readFile(pickedBrowserFiles.complete(f.owner, f.id))).toEqual(
    Buffer.from([1, 2, 3, 4, 5]),
  );
});
