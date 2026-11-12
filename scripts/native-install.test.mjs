import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { installNativeFiles } from './native-install.mjs';

async function fixture(t, original = true) {
  const directory = await mkdtemp(join(tmpdir(), 'weq-native-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'install');
  const source = join(directory, 'source');
  const paths = [
    'native/fixture/nt_helper.node',
    'resources/dress/bubble.dat',
    'native/.installed.json',
  ];
  const files = [];
  await mkdir(root);
  await mkdir(source);
  for (const [index, path] of paths.entries()) {
    const file = join(source, String(index));
    await writeFile(file, `new ${index}`);
    files.push({ source: file, path, mode: index === 0 ? 0o755 : 0o644 });
    if (original) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), `old ${index}`);
      await chmod(join(root, path), 0o640);
    }
  }
  return { root, files };
}

async function assertOriginal({ root, files }) {
  for (const [index, file] of files.entries()) {
    assert.equal(await readFile(join(root, file.path), 'utf8'), `old ${index}`);
    if (process.platform !== 'win32')
      assert.equal((await stat(join(root, file.path))).mode & 0o777, 0o640);
  }
  assert.ok(
    !(await readdir(join(root, 'native'))).some((name) => name.startsWith('.fetch-install-')),
  );
}

test('验证整套候选后替换原生文件与安装记录', async (t) => {
  const data = await fixture(t);
  let verified = false;
  await installNativeFiles({
    ...data,
    verify: async (staging) => {
      verified = true;
      assert.equal(await readFile(join(staging, data.files[0].path), 'utf8'), 'new 0');
      assert.equal(await readFile(join(data.root, data.files[0].path), 'utf8'), 'old 0');
    },
  });
  assert.ok(verified);
  for (const [index, file] of data.files.entries())
    assert.equal(await readFile(join(data.root, file.path), 'utf8'), `new ${index}`);
});

test('第二个文件替换失败后恢复旧内容、权限与 marker', async (t) => {
  const data = await fixture(t);
  let calls = 0;
  await assert.rejects(
    installNativeFiles({
      ...data,
      replace: async (source, dest) => {
        if (++calls === 2)
          throw Object.assign(new Error('simulated disk failure'), { code: 'ENOSPC' });
        return rename(source, dest);
      },
    }),
    /simulated disk failure/,
  );
  await assertOriginal(data);
});

test('首次安装中途失败时移除本次已安装文件', async (t) => {
  const data = await fixture(t, false);
  let calls = 0;
  await assert.rejects(
    installNativeFiles({
      ...data,
      replace: async (source, dest) => {
        if (++calls === 2) throw new Error('replace failed');
        return rename(source, dest);
      },
    }),
  );
  for (const file of data.files)
    await assert.rejects(readFile(join(data.root, file.path)), { code: 'ENOENT' });
});

test('候选 host 验证失败不替换任何文件', async (t) => {
  const data = await fixture(t);
  await assert.rejects(
    installNativeFiles({
      ...data,
      verify: async () => {
        throw new Error('native verification failed');
      },
    }),
    /native verification failed/,
  );
  await assertOriginal(data);
});

test('marker 无法准备时不开始替换', async (t) => {
  const data = await fixture(t);
  await rm(data.files[2].source);
  await assert.rejects(installNativeFiles(data), { code: 'ENOENT' });
  await assertOriginal(data);
});

test('真实 fetch 命令的 host 验证失败后保留旧 addon、marker 和版本锚', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'weq-native-fetch-verify-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'install');
  const source = join(directory, 'assets');
  const platform = `${process.platform}-${process.arch}`;
  const native = join(root, 'native', process.platform, process.arch);
  await mkdir(native, { recursive: true });
  await mkdir(source);
  const oldMarker = '{"tag":"old","files":[]}\n';
  const oldPin = '{"tag":"old"}\n';
  await writeFile(join(native, 'nt_helper.node'), 'original addon');
  await writeFile(join(root, 'native/.installed.json'), oldMarker);
  await writeFile(join(root, 'native/pinned.json'), oldPin);
  const bytes = Buffer.from('synthetic invalid addon');
  const asset = `nt_helper-${platform}.node`;
  await writeFile(join(source, asset), bytes);
  await writeFile(
    join(source, 'manifest.json'),
    JSON.stringify({
      tag: 'nt-helper-fixture',
      platforms: {
        [platform]: {
          asset,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./fetch-native.mjs', import.meta.url)),
      '--from-dir',
      source,
      '--root',
      root,
      '--no-dress',
      '--no-authorization',
      '--verify',
      '--write-pin',
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /验证失败/);
  assert.equal(await readFile(join(native, 'nt_helper.node'), 'utf8'), 'original addon');
  assert.equal(await readFile(join(root, 'native/.installed.json'), 'utf8'), oldMarker);
  assert.equal(await readFile(join(root, 'native/pinned.json'), 'utf8'), oldPin);
});
