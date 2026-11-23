// @vitest-environment node
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
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
      req.headers['if-none-match'] ?? null,
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

function manifest(
  html: string,
  key = 'weq-startup-resources',
): {
  version: number;
  waitForWorkspace?: boolean;
  resources: { path: string; size?: number }[];
} {
  let content = '';
  function visit(node: DefaultTreeAdapterMap['node']) {
    if ('attrs' in node && node.attrs.some((a) => a.name === 'name' && a.value === key))
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

it('Remote 用实际输出的 HTML 摘要做条件检查，切换协商方式或构建时返回新正文', async () => {
  const url = `http://127.0.0.1:${port}/`;
  const headers = { 'User-Agent': 'WeQRemote', 'Accept-Encoding': 'gzip' };
  const first = await fetch(url, { headers });
  const body = await first.text();
  const tag = `"weq-release-${createHash('sha256').update(body).digest('hex')}"`;
  expect(first.headers.get('etag')).toBe(tag);
  expect(first.headers.get('cache-control')).toBe('no-store');
  const same = await fetch(url, { headers: { ...headers, 'If-None-Match': `W/${tag}` } });
  expect(same.status).toBe(304);
  expect(await same.text()).toBe('');
  const identity = await fetch(url, {
    headers: { ...headers, 'Accept-Encoding': 'identity', 'If-None-Match': tag },
  });
  expect(identity.status).toBe(200);
  expect(identity.headers.get('etag')).not.toBe(tag);
  await writeFile(join(root, 'index.html'), shell.replace('id="root"', 'id="next"'));
  const updated = await fetch(url, { headers: { ...headers, 'If-None-Match': tag } });
  expect(updated.status).toBe(200);
  expect(updated.headers.get('etag')).not.toBe(tag);
  expect(await updated.text()).toContain('id="next"');
});

it.each(['gzip', 'identity'])(
  '首屏只计入直接资源，完整离线清单保留工作区资源：%s',
  async (encoding) => {
    const files = {
      '/assets/shared-12345678.js': 'export const shared=1;',
      '/assets/app-12345678.js': 'console.log("合成资源");'.repeat(1000),
      '/assets/app-12345678.css': '.synthetic { color: red; }'.repeat(100),
      '/assets/MainView-12345678.js': 'window.fixtureWorkspace=true;',
      '/assets/MainView-12345678.css': '.fixture-workspace {display:flex}',
    };
    for (const [path, body] of Object.entries(files)) await writeFile(join(root, path), body);
    await writeFile(
      join(root, 'weq-startup.json'),
      JSON.stringify({
        version: 1,
        entry: '/assets/app-12345678.js',
        resources: Object.entries(files).map(([path, body]) => ({
          path,
          raw: Buffer.byteLength(body),
          gzip: Buffer.byteLength(body) >= 1024 ? gzipSync(body).length : Buffer.byteLength(body),
          preload: path.includes('MainView'),
        })),
      }),
    );
    const html = (await get('/', encoding)).toString();
    const data = manifest(html);
    expect(data.resources).toHaveLength(3);
    const offline = manifest(html, 'weq-offline-bundle');
    expect(offline.waitForWorkspace).toBe(true);
    expect(offline.resources.map(({ path }) => path)).toEqual(Object.keys(files));
    for (const asset of data.resources)
      expect(asset.size).toBe((await get(asset.path, encoding)).length);
    expect(html).not.toContain('rel="modulepreload" href="/assets/MainView-12345678.js"');
    expect(html).not.toContain('rel="preload" href="/assets/MainView-12345678.css" as="style"');
    expect(html).not.toContain('src="/assets/MainView-12345678.js"');
    expect((await get('/', encoding, false)).toString()).toBe(shell);
  },
);

it.each([
  { version: 1, entry: '/assets/old-12345678.js', resources: [] },
  {
    version: 1,
    entry: '/assets/app-12345678.js',
    resources: [{ path: '/outside.js', raw: 1, gzip: 1, preload: true }],
  },
])('旧清单或非构建资源不进入首屏清单：%j', async (inventory) => {
  await writeFile(join(root, 'weq-startup.json'), JSON.stringify(inventory));
  expect(manifest((await get('/', 'gzip')).toString()).resources).toHaveLength(3);
});
