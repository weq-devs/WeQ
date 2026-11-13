import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  bundleMatches,
  installNativeBundle,
  nativePlatform,
  verifyNativeBundle,
} from './dev-native.mjs';
import { hashFile, writeJson } from './dev-prepare.mjs';

const kinds = ['font', 'bubble', 'widget'];

async function fixture(t, local) {
  const directory = await mkdtemp(join(tmpdir(), 'weq-dev-startup-acceptance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  const bundle = join(directory, 'bundle');
  const platform = nativePlatform();
  const addon = join(bundle, platform.directory, 'nt_helper.node');
  const loader = join(directory, 'synthetic-loader.cjs');
  await mkdir(dirname(addon), { recursive: true });
  await mkdir(root);
  // 这里只验证启动脚本的分支与子进程参数，不把合成模块冒称为真实 NAPI 产物。
  await writeFile(loader, 'require.extensions[".node"] = require.extensions[".js"];');
  await writeFile(
    addon,
    `module.exports = {
      getInitStatus: () => 0,
      getBuildInfo: () => ({isDev: ${JSON.stringify(local)}}),
      queryDressResourceUrl: (kind) => require('node:fs').existsSync(
        require('node:path').join(process.env.NT_HELPER_DRESS_DIR, kind + '.dat')
      ) ? {url: 'https://fixture.invalid/resource'} : null,
    };`,
  );
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(loader)}`,
  };
  return { root, bundle, platform, env, addon };
}

test('真实验证子进程：release 不读取缺失的 ranking 或三份索引', async (t) => {
  const data = await fixture(t, false);
  await verifyNativeBundle(data.bundle, data.root, data);
  const marker = {
    files: [
      { path: `${data.platform.directory}/nt_helper.node`, sha256: await hashFile(data.addon) },
    ],
  };
  assert.equal(await bundleMatches(data.bundle, marker, data.platform, { withDress: false }), true);
  assert.equal(await bundleMatches(data.bundle, marker, data.platform), false);
});

test('真实验证子进程：local 缺配套索引失败，补齐后三类均须可读', async (t) => {
  const data = await fixture(t, true);
  for (const kind of kinds) {
    await writeJson(join(data.root, `resources/dress/ranking-${kind}.json`), {
      response: { items: [{ item: { itemId: 1 } }] },
    });
  }
  await assert.rejects(verifyNativeBundle(data.bundle, data.root, { ...data, local: true }));
  await mkdir(join(data.bundle, 'resources/dress'), { recursive: true });
  for (const kind of kinds) await writeFile(join(data.bundle, `resources/dress/${kind}.dat`), kind);
  await verifyNativeBundle(data.bundle, data.root, { ...data, local: true });
  await rm(join(data.bundle, 'resources/dress/widget.dat'));
  await assert.rejects(verifyNativeBundle(data.bundle, data.root, { ...data, local: true }));
});

test('release 安装只记录真实 native 文件，不删除或覆盖旧装扮索引', async (t) => {
  const data = await fixture(t, false);
  for (const kind of kinds) {
    const file = join(data.root, `resources/dress/${kind}.dat`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `legacy ${kind}`);
  }
  const next = await installNativeBundle({
    ...data,
    marker: { tag: 'release-fixture' },
    withDress: false,
    verify: async () => {},
    unused: async () => {},
  });
  assert.deepEqual(
    next.files.map((file) => file.path),
    [`${data.platform.directory}/nt_helper.node`],
  );
  assert.equal(await bundleMatches(data.root, next, data.platform, { withDress: false }), true);
  for (const kind of kinds)
    assert.equal(
      await readFile(join(data.root, `resources/dress/${kind}.dat`), 'utf8'),
      `legacy ${kind}`,
    );
});
