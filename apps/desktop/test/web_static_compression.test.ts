// @vitest-environment node
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { serveStatic } from '../src/main/web/static';

let root: string;
let server: Server;
let port: number;
const script = 'console.log("合成静态资源");\n'.repeat(1000);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'weq-static-compression-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<title>合成首页</title>');
  writeFileSync(join(root, 'assets/app-test.js'), script);
  writeFileSync(join(root, 'assets/image.png'), Buffer.alloc(2048, 1));
  server = createServer((req, res) => {
    void serveStatic(res, root, req.url ?? '/', req.headers['accept-encoding']);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing listener');
  port = address.port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

function get(path: string, encoding?: string) {
  return new Promise<{ headers: import('node:http').IncomingHttpHeaders; body: Buffer }>(
    (resolve, reject) => {
      request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          headers: encoding ? { 'Accept-Encoding': encoding } : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        },
      )
        .on('error', reject)
        .end();
    },
  );
}

it('协商 gzip 压缩脚本，保留原 MIME 与 immutable 缓存，解压后内容一致', async () => {
  const { headers, body } = await get('/assets/app-test.js', 'br, gzip');
  expect(headers['content-encoding']).toBe('gzip');
  expect(headers.vary).toBe('Accept-Encoding');
  expect(headers['content-type']).toContain('javascript');
  expect(headers['cache-control']).toContain('immutable');
  expect(headers['content-length']).toBeUndefined();
  expect(headers['accept-ranges']).toBeUndefined();
  expect(gunzipSync(body).toString()).toBe(script);
  expect(body.length).toBeLessThan(Buffer.byteLength(script) / 4);
});

it.each([undefined, 'br', 'gzip;q=0', '*;q=1, gzip;q=0', 'gzip;q=invalid'])(
  '不支持或禁止 gzip 时仍返回原文：%s',
  async (encoding) => {
    const { headers, body } = await get('/assets/app-test.js', encoding);
    expect(headers['content-encoding']).toBeUndefined();
    expect(headers.vary).toBe('Accept-Encoding');
    expect(body.toString()).toBe(script);
  },
);

it('通配符协商可压缩，但图片和首页不启用资源长缓存或额外压缩', async () => {
  expect((await get('/assets/app-test.js', '*;q=0.5')).headers['content-encoding']).toBe('gzip');
  const image = await get('/assets/image.png', 'gzip');
  expect(image.headers['content-encoding']).toBeUndefined();
  expect(image.body).toEqual(Buffer.alloc(2048, 1));
  const shell = await get('/some/page', 'gzip');
  expect(shell.headers['cache-control']).toBe('no-store');
  expect(shell.headers['content-encoding']).toBeUndefined();
});
