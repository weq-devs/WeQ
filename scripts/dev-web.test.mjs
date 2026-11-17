import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { developmentWeb, prepareWebAssets } from './dev-web.mjs';

test('真实 Vite 开发服务持续推送源码更新，并随桌面服务关闭；不写正式产物', {
  timeout: 20_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'weq-live-web-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'apps/web');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await symlink(
    new URL('../apps/web/node_modules', import.meta.url),
    join(directory, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(
    join(directory, 'vite.config.ts'),
    `import {developmentSourceMaps} from ${JSON.stringify(fileURLToPath(new URL('../apps/web/scripts/development-assets.ts', import.meta.url)))};
    export default { plugins: [developmentSourceMaps()], root: ${JSON.stringify(directory)}, cacheDir: ${JSON.stringify(join(root, 'vite-cache'))}, server: { watch: { usePolling: true, interval: 20 } } };`,
  );
  await writeFile(join(directory, 'index.html'), '<script type="module" src="/entry.js"></script>');
  const entry = join(directory, 'entry.js');
  await writeFile(entry, 'export const value = 1; if (import.meta.hot) import.meta.hot.accept();');
  const desktop = createServer();
  desktop.listen(0, '127.0.0.1');
  await once(desktop, 'listening');
  const old = process.env.WEQ_DEV_WEB_URL;
  t.after(async () => {
    if (desktop.listening) await new Promise((resolve) => desktop.close(resolve));
    if (old === undefined) delete process.env.WEQ_DEV_WEB_URL;
    else process.env.WEQ_DEV_WEB_URL = old;
  });
  const plugin = developmentWeb(root);
  assert.equal(plugin.apply, 'serve');
  await plugin.configureServer({ httpServer: desktop });
  const url = process.env.WEQ_DEV_WEB_URL;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(await (await fetch(url)).text(), /\/@vite\/client/);
  const client = await (await fetch(`${url}/@vite/client`)).text();
  const token = /const wsToken = "([^"]+)"/.exec(client)?.[1];
  assert(token, '必须使用真实 Vite 返回的 WebSocket token');
  const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
  const { default: WebSocket } = await import(require.resolve('ws'));
  const ws = new WebSocket(
    `${url.replace('http:', 'ws:')}/_weq-dev/hmr?token=${token}`,
    'vite-hmr',
  );
  t.after(() => ws.terminate());
  const connected = once(ws, 'message');
  await once(ws, 'open');
  assert.equal(JSON.parse(String((await connected)[0])).type, 'connected');
  assert.match(await (await fetch(`${url}/entry.js`)).text(), /value = 1/);
  const module = await (await fetch(`${url}/entry.js`)).text();
  assert(!module.includes('sourceMappingURL=data:'), '运行模块不应携带整份内联源码映射');
  await writeFile(join(directory, 'source.ts'), 'export const value: number = 42;');
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

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'weq-dev-web-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const put = async (name, value) => {
    const path = resolve(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  };
  await put('apps/desktop/src/renderer/src/App.tsx', 'export const value = 1;');
  await put('apps/desktop/src/renderer/src/styles.css', '.one { color: red }');
  await put('apps/web/vite.config.ts', 'export default {};');
  await put('resources/brand/logo.png', 'synthetic image');
  await put('pnpm-lock.yaml', 'synthetic-lock');
  await put('node_modules/.modules.yaml', 'synthetic-installation');
  const state = { builds: 0, child: null, mutate: null };
  const build = async (_root, env) => {
    state.builds++;
    state.child = env;
    const output = resolve(env.WEQ_WEB_DIST ?? join(root, 'apps/web/dist'), 'public');
    await rm(output, { recursive: true, force: true });
    await put(join(output, 'index.html'), '<script type="module" src="/assets/app.js"></script>');
    await put(join(output, 'assets/app.js'), 'console.log("synthetic");');
    await put(join(output, 'assets/app.css'), '.synthetic {}');
    await put(
      join(output, '.vite/manifest.json'),
      JSON.stringify({
        'index.html': { file: 'assets/app.js', isEntry: true, css: ['assets/app.css'] },
      }),
    );
    await state.mutate?.();
  };
  const env = { NODE_ENV_ELECTRON_VITE: 'development' };
  const prepare = (options = {}) => prepareWebAssets(root, { env, build, log() {}, ...options });
  return {
    root,
    put,
    state,
    env,
    prepare,
    output: join(root, 'apps/web/dist/public'),
    marker: join(root, '.weq-dev/web-build.json'),
  };
}

test('开发首次构建，未变化时复用且子进程仍使用 production', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.prepare()).cached, false);
  assert.equal((await f.prepare()).cached, true);
  assert.equal(f.state.builds, 1);
  assert.equal(f.state.child.NODE_ENV, 'production');
  assert.equal(f.state.child.WEQ_DEV_WEB_CACHE, '1');
});

test('管道中的 Web 缓存命中日志继承外层终端颜色', async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const env = { ...process.env, WEQ_DEV_STDOUT_TTY: '1' };
  delete env.NO_COLOR;
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import { prepareWebAssets } from ${JSON.stringify(new URL('./dev-web.mjs', import.meta.url).href)};
      await prepareWebAssets(${JSON.stringify(f.root)}, {
        env: ${JSON.stringify(f.env)},
        cache: true,
        build() { throw new Error('缓存命中不应重建'); },
      });
      `,
    ],
    { encoding: 'utf8', env },
  );
  assert(output.includes('\x1b[32mINFO '));
  assert(output.includes('\x1b[36mvite-web'));
  assert.match(output, /内置 Web 资源未变化，复用已有构建/);
});

for (const name of [
  'apps/desktop/src/renderer/src/App.tsx',
  'apps/desktop/src/renderer/src/styles.css',
  'apps/desktop/src/renderer/src/NewPanel.tsx',
  'apps/desktop/src/renderer/.env.local',
  'apps/web/vite.config.ts',
  'apps/desktop/electron.vite.config.ts',
  'packages/time/tsconfig.json',
  'packages/time/src/index.ts',
  'resources/brand/logo.png',
  'pnpm-lock.yaml',
  'node_modules/.modules.yaml',
])
  test(`相关输入变化会重建：${name}`, async (t) => {
    const f = await fixture(t);
    await f.prepare();
    await f.put(name, 'changed');
    assert.equal((await f.prepare()).cached, false);
    assert.equal(f.state.builds, 2);
  });

test('改动内容即使恢复修改时间也不复用旧产物，仅触碰相同内容仍可复用', async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const path = join(f.root, 'apps/desktop/src/renderer/src/App.tsx');
  const old = await stat(path);
  await f.put(path, 'export const value = 2;');
  await utimes(path, old.atime, old.mtime);
  assert.equal((await f.prepare()).cached, false);
  await utimes(path, new Date(), new Date(Date.now() + 1000));
  assert.equal((await f.prepare()).cached, true);
});

for (const name of ['assets/app.js', 'assets/app.css', '.vite/manifest.json']) {
  test(`产物缺失或损坏会重建：${name}`, async (t) => {
    const f = await fixture(t);
    await f.prepare();
    await rm(join(f.output, name));
    assert.equal((await f.prepare()).cached, false);
    await f.put(join(f.output, name), 'corrupted');
    assert.equal((await f.prepare()).cached, false);
  });
}

test('缓存 JSON 损坏按未命中处理，失败构建不复用旧标记', async (t) => {
  const f = await fixture(t);
  await f.prepare();
  await f.put(f.marker, '{broken');
  assert.equal((await f.prepare()).cached, false);
  const original = await readFile(join(f.root, 'apps/desktop/src/renderer/src/App.tsx'), 'utf8');
  await f.put('apps/desktop/src/renderer/src/App.tsx', 'pending');
  await assert.rejects(
    f.prepare({
      build: async () => {
        throw new Error('synthetic failure');
      },
    }),
    /synthetic failure/,
  );
  await f.put('apps/desktop/src/renderer/src/App.tsx', original);
  assert.equal((await f.prepare()).cached, false);
});

test('构建期间输入变化不写入可复用标记', async (t) => {
  const f = await fixture(t);
  f.state.mutate = () => f.put('apps/desktop/src/renderer/src/App.tsx', 'changed during build');
  await f.prepare();
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
  f.state.mutate = null;
  assert.equal((await f.prepare()).cached, false);
  assert.equal((await f.prepare()).cached, true);
});

test('正式构建始终重建，VITE 环境和输出目录变化不会错用缓存', async (t) => {
  const f = await fixture(t);
  await f.prepare();
  assert.equal((await f.prepare({ env: { ...f.env, VITE_TEST: 'changed' } })).cached, false);
  assert.equal(
    (await f.prepare({ env: { ...f.env, WEQ_WEB_DIST: join(f.root, 'other') } })).cached,
    false,
  );
  const env = { NODE_ENV_ELECTRON_VITE: 'production' };
  assert.equal((await f.prepare({ env })).cached, false);
  assert.equal((await f.prepare({ env })).cached, false);
  assert.equal(f.state.child.WEQ_DEV_WEB_CACHE, '0');
});
