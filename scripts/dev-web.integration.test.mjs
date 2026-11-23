import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { developmentWeb } from './dev-web.mjs';

const { developmentSourceMaps } = await tsImport(
  '../apps/web/scripts/development-assets.ts',
  import.meta.url,
);

test('真实 Vite 开发服务持续推送源码更新，并随桌面服务关闭；不写正式产物', {
  timeout: 20_000,
}, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'weq-live-web-')));
  const desktop = createServer();
  const old = process.env.WEQ_DEV_WEB_URL;
  const oldMode = process.env.WEQ_DEV_WEB_UNBUNDLED;
  process.env.WEQ_DEV_WEB_UNBUNDLED = '1';
  let ws;
  t.after(async () => {
    ws?.terminate();
    try {
      if (desktop.listening) await new Promise((resolve) => desktop.close(resolve));
    } finally {
      if (old === undefined) delete process.env.WEQ_DEV_WEB_URL;
      else process.env.WEQ_DEV_WEB_URL = old;
      if (oldMode === undefined) delete process.env.WEQ_DEV_WEB_UNBUNDLED;
      else process.env.WEQ_DEV_WEB_UNBUNDLED = oldMode;
      await rm(root, { recursive: true, force: true });
    }
  });
  const directory = join(root, 'apps/web');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await mkdir(join(directory, 'node_modules'));
  await symlink(
    await realpath(new URL('../apps/web/node_modules/vite', import.meta.url)),
    join(directory, 'node_modules/vite'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(
    join(directory, 'vite.config.ts'),
    `export default { root: ${JSON.stringify(directory)}, cacheDir: ${JSON.stringify(join(root, 'vite-cache'))}, server: { watch: { usePolling: true, interval: 20 } } };`,
  );
  await writeFile(join(directory, 'index.html'), '<script type="module" src="/entry.js"></script>');
  const entry = join(directory, 'entry.js');
  await writeFile(entry, 'export const value = 1; if (import.meta.hot) import.meta.hot.accept();');
  await writeFile(join(directory, 'source.ts'), 'export const value: number = 42;');
  desktop.listen(0, '127.0.0.1');
  await once(desktop, 'listening');
  const plugin = developmentWeb(root, { plugins: [developmentSourceMaps()] });
  assert.equal(plugin.apply, 'serve');
  await plugin.configureServer({ httpServer: desktop });
  const url = process.env.WEQ_DEV_WEB_URL;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(await (await fetch(url)).text(), /\/@vite\/client/);
  const client = await (await fetch(`${url}/@vite/client`)).text();
  const token = /const wsToken = "([^"]+)"/.exec(client)?.[1];
  assert(token, '必须使用真实 Vite 返回的 WebSocket token');
  const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
  const { default: WebSocket } = await import(pathToFileURL(require.resolve('ws')).href);
  ws = new WebSocket(`${url.replace('http:', 'ws:')}/_weq-dev/hmr?token=${token}`, 'vite-hmr');
  const connected = once(ws, 'message');
  await once(ws, 'open');
  assert.equal(JSON.parse(String((await connected)[0])).type, 'connected');
  assert.match(await (await fetch(`${url}/entry.js`)).text(), /value = 1/);
  const module = await (await fetch(`${url}/entry.js`)).text();
  assert(!module.includes('sourceMappingURL=data:'), '运行模块不应携带整份内联源码映射');
  const source = await (await fetch(`${url}/source.ts?t=123`)).text();
  assert(!source.includes('sourceMappingURL=data:'));
  const mapPath = /sourceMappingURL=(\S+)/.exec(source)?.[1];
  assert(mapPath, '真正转换过的源码仍应能按需调试');
  const map = await (await fetch(new URL(mapPath, url))).json();
  assert.equal(map.version, 3);
  assert(map.sourcesContent.includes('export const value: number = 42;'));
  const update = new Promise((resolve) =>
    ws.on('message', (message) => {
      const data = JSON.parse(String(message));
      if (data.type === 'update') resolve(data);
    }),
  );
  await writeFile(entry, 'export const value = 2; if (import.meta.hot) import.meta.hot.accept();');
  assert((await update).updates.some((change) => change.path === '/entry.js'));
  assert.match(await (await fetch(`${url}/entry.js`)).text(), /value = 2/);
  await assert.rejects(stat(join(root, 'apps/web/dist')), { code: 'ENOENT' });
  const closed = once(ws, 'close');
  await new Promise((resolve) => desktop.close(resolve));
  await closed;
  assert.equal(process.env.WEQ_DEV_WEB_URL, undefined);
});
