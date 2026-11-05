import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prepareDevElectron } from './prepare-dev-electron.mjs';

const run = promisify(execFile);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'weq-dev-electron-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source/Electron.app');
  const executable = join(source, 'Contents/MacOS/Electron');
  await mkdir(join(source, 'Contents/MacOS'), { recursive: true });
  await copyFile('/bin/echo', executable);
  await writeFile(
    join(source, 'Contents/Info.plist'),
    `<?xml version="1.0"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>app.weq.synthetic-dev</string></dict></plist>`,
  );
  await run('/usr/bin/codesign', ['--force', '--sign', '-', source]);
  const helper = join(source, 'Contents/Frameworks/fixture-helper');
  await mkdir(join(source, 'Contents/Frameworks'));
  await copyFile('/bin/echo', helper);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', helper]);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', source]);
  return { executable, directory: join(directory, 'prepared'), platform: 'darwin' };
}

test('开发入口先准备带调试权限的宿主，保留原开发账号目录参数', async () => {
  const desktop = JSON.parse(
    await readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'),
  );
  assert.match(desktop.scripts.dev, /prepare-dev-electron\.mjs --launch/);
  assert.match(desktop.scripts.dev, /--user-data-dir=\.\.\/\.\.\/\.dev-profile/);
});

test('非 macOS 保持原宿主，不要求本机签名工具', async () => {
  assert.equal(
    await prepareDevElectron({ platform: 'linux', executable: '/fixture/electron' }),
    '/fixture/electron',
  );
});

test('真实系统签名补齐主进程权限，源文件保真，重复启动复用缓存', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const options = await fixture(t);
  const original = await readFile(options.executable);
  const target = await prepareDevElectron(options);
  assert.notEqual(target, options.executable);
  assert.deepEqual(await readFile(options.executable), original);
  assert.deepEqual(
    await readFile(join(options.directory, 'Electron.app/Contents/Frameworks/fixture-helper')),
    await readFile(join(options.executable, '../../Frameworks/fixture-helper')),
  );
  const { stdout } = await run('/usr/bin/codesign', ['-d', '--entitlements', '-', target]);
  assert.match(stdout, /com\.apple\.security\.cs\.debugger/);
  await run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    join(options.directory, 'Electron.app'),
  ]);
  const before = await stat(target);
  assert.equal(await prepareDevElectron(options), target);
  assert.equal((await stat(target)).ino, before.ino);
});

test('运行中的有效宿主可复用，需要更新时不替换正在运行的应用', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const options = await fixture(t);
  await copyFile('/bin/sleep', options.executable);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', options.executable]);
  const target = await prepareDevElectron(options);
  const child = spawn(target, ['30']);
  await once(child, 'spawn');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  assert.equal(await prepareDevElectron(options), target);
  const entitlementPath = join(options.directory, 'changed.plist');
  const existing = await readFile(
    new URL('../apps/desktop/build/entitlements.mac.plist', import.meta.url),
  );
  await writeFile(entitlementPath, Buffer.concat([existing, Buffer.from('\n')]));
  const before = await stat(target);
  await assert.rejects(prepareDevElectron({ ...options, entitlementPath }), /先按 Cmd\+Q/);
  assert.equal((await stat(target)).ino, before.ino);
});

test('损坏缓存重新准备；源二进制和权限清单变化均使缓存失效', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const options = await fixture(t);
  const target = await prepareDevElectron(options);
  await writeFile(target, 'broken');
  assert.equal(await prepareDevElectron(options), target);
  const before = await stat(target);
  await copyFile('/bin/pwd', options.executable);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', options.executable]);
  await prepareDevElectron(options);
  assert.notEqual((await stat(target)).ino, before.ino);
  const changed = await stat(target);
  const entitlementPath = join(options.directory, 'extra.plist');
  const existing = await readFile(
    new URL('../apps/desktop/build/entitlements.mac.plist', import.meta.url),
    'utf8',
  );
  await writeFile(
    entitlementPath,
    existing.replace('</dict>', '<key>app.weq.synthetic</key><true/></dict>'),
  );
  await prepareDevElectron({ ...options, entitlementPath });
  assert.notEqual((await stat(target)).ino, changed.ino);
});

test('未知应用及遗留锁不覆盖；签名失败清理本轮暂存并保留原缓存', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const options = await fixture(t);
  const target = join(options.directory, 'Electron.app');
  await mkdir(target, { recursive: true });
  await assert.rejects(prepareDevElectron(options), /非管理应用/);
  await rm(target, { recursive: true });
  await mkdir(join(options.directory, '.prepare-lock'));
  await assert.rejects(prepareDevElectron(options), /留下锁/);
  await rm(join(options.directory, '.prepare-lock'), { recursive: true });
  const prepared = await prepareDevElectron(options);
  const before = await stat(prepared);
  const entitlementPath = join(options.directory, 'bad.plist');
  await writeFile(entitlementPath, 'invalid plist');
  await assert.rejects(prepareDevElectron({ ...options, entitlementPath }));
  assert.equal((await stat(prepared)).ino, before.ino);
  assert.equal(await prepareDevElectron(options), prepared);
});
