import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { prepareWebAssets } from './dev-web.mjs';

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
