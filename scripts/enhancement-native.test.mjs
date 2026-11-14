import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('发布预检拒绝旧原生接口、同步冒充异步及错密钥来源，接受完整配套接口', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'weq-native-enhancement-contract-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const addon = join(root, 'fixture.cjs');
  const manifest = join(root, 'manifest.json');
  const commit = 'a'.repeat(40);
  await writeFile(manifest, JSON.stringify({ nativeCommit: commit }));
  const check = () =>
    execFileSync(
      process.execPath,
      [
        resolve('scripts/verify-enhancement-engines.mjs'),
        '--native-only',
        '--addon',
        addon,
        '--manifest',
        manifest,
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    );
  const fixture = (methods) =>
    `module.exports={getInitStatus:()=>0,getBuildInfo:()=>({isDev:false}),${methods}};`;
  await writeFile(addon, fixture(''));
  assert.throws(check);
  const methods = `getDressResourceKeyId:()=>"${commit}",clearDressResourceIndexes:()=>{},validateDressResourceIndexes:()=>Promise.resolve(false),reloadDressResourceIndexes:()=>Promise.resolve(false)`;
  await writeFile(addon, fixture(methods));
  assert.match(check(), /配套密钥身份通过/);
  await writeFile(addon, fixture(methods.replace('()=>Promise.resolve(false)', '()=>false')));
  assert.throws(check);
  await writeFile(addon, fixture(methods.replace(commit, 'b'.repeat(40))));
  assert.throws(check);
});
