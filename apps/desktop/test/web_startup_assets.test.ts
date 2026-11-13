// @vitest-environment node
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { serveStatic } from '../src/main/web/static';

let root: string;
let server: Server;
let port: number;
const shell =
  '<!doctype html><head><link rel="modulepreload" href="/assets/shared-12345678.js"><link rel="stylesheet" href="/assets/app-12345678.css"><script type="module" src="/assets/app-12345678.js"></script><link rel="modulepreload" href="/assets/shared-12345678.js"><script src="https://other.invalid/assets/external.js"></script><script src="/outside.js"></script></head><body><div id="root"></div></body>';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'weq-startup-assets-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), shell);
  await writeFile(join(root, 'assets/shared-12345678.js'), 'export const shared=1;');
  await writeFile(join(root, 'assets/app-12345678.js'), 'console.log("合成资源");'.repeat(1000));
  await writeFile(join(root, 'assets/app-12345678.css'), '.synthetic { color: red; }'.repeat(100));
  server = createServer((req, res) => {
    void serveStatic(
      res,
      root,
      req.url ?? '/',
      req.headers['accept-encoding'],
      req.headers['user-agent'] === 'WeQRemote',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing listener');
  port = address.port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

function get(path: string, encoding: string, remote = true) {
  return new Promise<Buffer>((resolve, reject) => {
    request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        headers: { 'Accept-Encoding': encoding, 'User-Agent': remote ? 'WeQRemote' : 'Browser' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    )
      .on('error', reject)
      .end();
  });
}

function manifest(html: string): { version: number; resources: { path: string; size: number }[] } {
  let content = '';
  function visit(node: DefaultTreeAdapterMap['node']) {
    if (
      'attrs' in node &&
      node.attrs.some((a) => a.name === 'name' && a.value === 'weq-startup-resources')
    )
      content = node.attrs.find((a) => a.name === 'content')?.value ?? '';
    if ('childNodes' in node) node.childNodes.forEach(visit);
  }
  visit(parse(html));
  return JSON.parse(content);
}

it.each(['gzip', 'gzip;q=0', 'br'])(
  '清单逐项大小等于实际响应体，不把 gzip、重复预载或外站资源算错：%s',
  async (encoding) => {
    const html = (await get('/', encoding)).toString();
    const data = manifest(html);
    expect(data.version).toBe(1);
    expect(data.resources).toHaveLength(3);
    for (const asset of data.resources)
      expect(asset.size).toBe((await get(asset.path, encoding)).length);
    expect(html.indexOf('weq-startup-resources')).toBeLessThan(html.indexOf('rel="modulepreload"'));
  },
);

it('普通浏览器不改变 HTML，更新入口后不沿用旧清单', async () => {
  expect((await get('/', 'gzip', false)).toString()).toBe(shell);
  await get('/', 'gzip');
  await writeFile(
    join(root, 'index.html'),
    '<script type="module" src="/assets/shared-12345678.js"></script>',
  );
  expect(manifest((await get('/', 'gzip')).toString()).resources).toHaveLength(1);
});
