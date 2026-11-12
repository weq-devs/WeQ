import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./fetch-native.mjs', import.meta.url));

test('默认维护仅取 native，旧资源可显式获取，检查不依赖已移除的可选索引', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'native-dress-optional-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tag = 'nt-helper-fixture';
  const platform = `${process.platform}-${process.arch}`;
  const bytes = Buffer.from('synthetic-native');
  const meta = {
    asset: `nt_helper-${platform}.node`,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const manifest = { tag, platforms: { [platform]: meta }, dress: {} };
  for (const kind of ['font', 'bubble', 'widget'])
    manifest.dress[kind] = { asset: `dress-${kind}.dat`, sha256: '0'.repeat(64), size: 32 };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  await mkdir(join(root, 'native', process.platform, process.arch), { recursive: true });
  const path = `native/${process.platform}/${process.arch}/nt_helper.node`;
  await writeFile(join(root, path), bytes);
  await writeFile(join(root, 'native/pinned.json'), JSON.stringify({ tag }));
  await writeFile(
    join(root, 'native/.installed.json'),
    JSON.stringify({
      tag,
      files: [
        { path, sha256: meta.sha256 },
        { path: 'resources/dress/bubble.dat', sha256: '0'.repeat(64) },
      ],
    }),
  );
  const run = (...args) =>
    execFileSync(
      process.execPath,
      [script, '--root', root, '--from-dir', root, '--version', tag, '--no-authorization', ...args],
      { encoding: 'utf8' },
    );
  const nativeOnly = run('--dry-run');
  assert(nativeOnly.includes('nt_helper.node'));
  assert(!nativeOnly.includes('→ resources/dress/'));
  const all = run('--dry-run', '--with-dress');
  for (const kind of ['font', 'bubble', 'widget'])
    assert(all.includes(`resources/dress/${kind}.dat`));
  const dressOnly = run('--dry-run', '--dress-only');
  assert(!dressOnly.includes('nt_helper.node'));
  assert(dressOnly.includes('resources/dress/font.dat'));
  assert(run('--check').includes('一致'));
});
