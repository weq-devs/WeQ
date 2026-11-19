import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { prepareDevElectron } from './prepare-dev-electron.mjs';

const run = promisify(execFile);

async function bitmapPixels(path) {
  const bitmap = `${path}.bmp`;
  await run('/usr/bin/sips', ['--setProperty', 'format', 'bmp', path, '--out', bitmap]);
  const data = await readFile(bitmap);
  assert.equal(data.subarray(0, 2).toString(), 'BM');
  return data.subarray(data.readUInt32LE(10));
}

async function fixture(t, { signed = true } = {}) {
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
<key>CFBundleName</key><string>Electron</string>
<key>CFBundleDisplayName</key><string>Electron</string>
<key>CFBundleIconFile</key><string>electron.icns</string>
<key>CFBundleIdentifier</key><string>app.weq.synthetic-dev</string></dict></plist>`,
  );
  await mkdir(join(source, 'Contents/Resources'), { recursive: true });
  await writeFile(join(source, 'Contents/Resources/electron.icns'), 'source icon');
  const iconPath = join(directory, 'logo.png');
  await copyFile(new URL('../resources/brand/logo.png', import.meta.url), iconPath);
  // 嵌套项用 .app 布局，`codesign --deep` 只对可识别的 bundle 递归签名。
  const helper = join(source, 'Contents/Frameworks/Fixture Helper.app');
  const helperExec = join(helper, 'Contents/MacOS/Fixture Helper');
  await mkdir(dirname(helperExec), { recursive: true });
  await copyFile('/bin/echo', helperExec);
  await writeFile(
    join(helper, 'Contents/Info.plist'),
    `<?xml version="1.0"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture Helper</string>
<key>CFBundleIdentifier</key><string>app.weq.synthetic-dev.helper</string></dict></plist>`,
  );
  // 真实 Helper 都带 Resources；缺了 codesign 会因为"签名声明有资源"拒绝验证。
  await mkdir(join(helper, 'Contents/Resources'), { recursive: true });
  if (signed) {
    await run('/usr/bin/codesign', ['--force', '--sign', '-', helper]);
    await run('/usr/bin/codesign', ['--force', '--sign', '-', source]);
  } else {
    // /bin/echo 自带 Apple 平台签名，必须剥掉才能模拟"整包未签名"的发行物。
    for (const path of [helperExec, executable]) {
      await run('/usr/bin/codesign', ['--remove-signature', path]);
    }
  }
  return {
    executable,
    source,
    iconPath,
    directory: join(directory, 'prepared'),
    platform: 'darwin',
  };
}

test('开发入口先准备带调试权限的宿主，保留原开发账号目录参数', async () => {
  const desktop = JSON.parse(
    await readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'),
  );
  assert.equal(desktop.scripts.dev, 'node ../../scripts/dev.mjs');
  const config = JSON.parse(await readFile(new URL('../weq.dev.json', import.meta.url), 'utf8'));
  assert.equal(config.userDataDir, '.dev-profile');
});

test('非 macOS 保持原宿主，不要求本机签名工具', async () => {
  assert.equal(
    await prepareDevElectron({ platform: 'linux', executable: '/fixture/electron' }),
    '/fixture/electron',
  );
});

test('开发宿主写入独立应用身份和真正的 WeQ 图标，不修改 Electron 原件', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const options = await fixture(t);
  const sourcePlist = join(options.source, 'Contents/Info.plist');
  const original = await readFile(sourcePlist);
  const target = await prepareDevElectron(options);
  const app = join(options.directory, 'Electron.app');
  const { stdout } = await run('/usr/bin/plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    join(app, 'Contents/Info.plist'),
  ]);
  const info = JSON.parse(stdout);
  assert.equal(info.CFBundleIdentifier, 'app.weq.desktop.dev');
  assert.equal(info.CFBundleName, 'WeQ Dev');
  assert.equal(info.CFBundleDisplayName, info.CFBundleName);
  assert.equal(target, join(app, 'Contents/MacOS', info.CFBundleExecutable));
  assert.notEqual(info.CFBundleIconFile, 'electron.icns');
  const icon = join(app, 'Contents/Resources', info.CFBundleIconFile);
  assert.equal((await readFile(icon)).subarray(0, 4).toString(), 'icns');
  const decoded = join(options.directory, 'decoded.iconset');
  await run('/usr/bin/iconutil', ['--convert', 'iconset', '--output', decoded, icon]);
  const { stdout: dimensions } = await run('/usr/bin/sips', [
    '-g',
    'pixelWidth',
    '-g',
    'pixelHeight',
    join(decoded, 'icon_512x512@2x.png'),
  ]);
  assert.match(dimensions, /pixelWidth: 1024/);
  assert.match(dimensions, /pixelHeight: 1024/);
  const expected = join(options.directory, 'expected.png');
  await run('/usr/bin/sips', [
    '--resampleHeightWidth',
    '1024',
    '1024',
    options.iconPath,
    '--out',
    expected,
  ]);
  // iconutil 会改写 PNG 色彩元数据；比较解码后的像素，且不引入 bootstrap 依赖。
  assert.deepEqual(
    await bitmapPixels(join(decoded, 'icon_512x512@2x.png')),
    await bitmapPixels(expected),
  );
  assert.deepEqual(await readFile(sourcePlist), original);
  assert.equal(
    await readFile(join(options.source, 'Contents/Resources/electron.icns'), 'utf8'),
    'source icon',
  );
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const { stderr: signature } = await run('/usr/bin/codesign', ['--display', '--verbose=2', app]);
  assert.ok(signature.split('\n').includes(`Identifier=${info.CFBundleIdentifier}`));
});

test('旧开发宿主自动迁入 WeQ 身份，图标及源应用元数据变化会重建缓存', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const options = await fixture(t);
  const target = await prepareDevElectron(options);
  const markerPath = join(options.directory, 'weq-runtime.json');
  const current = JSON.parse(await readFile(markerPath, 'utf8'));
  await writeFile(markerPath, JSON.stringify({ ...current, format: 1 }));
  let before = await stat(target);
  await prepareDevElectron(options);
  assert.notEqual((await stat(target)).ino, before.ino);
  before = await stat(target);
  const resized = join(options.directory, 'resized.png');
  await run('/usr/bin/sips', [
    '--resampleHeightWidth',
    '128',
    '128',
    options.iconPath,
    '--out',
    resized,
  ]);
  await copyFile(resized, options.iconPath);
  await prepareDevElectron(options);
  assert.notEqual((await stat(target)).ino, before.ino);
  before = await stat(target);
  await run('/usr/bin/plutil', [
    '-insert',
    'FixtureMetadata',
    '-string',
    'changed',
    join(options.source, 'Contents/Info.plist'),
  ]);
  await prepareDevElectron(options);
  assert.notEqual((await stat(target)).ino, before.ino);
});

test('真实系统签名补齐主进程权限，源文件保真，重复启动复用缓存', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const options = await fixture(t);
  const original = await readFile(options.executable);
  const target = await prepareDevElectron(options);
  assert.notEqual(target, options.executable);
  assert.deepEqual(await readFile(options.executable), original);
  const relativeHelper = 'Contents/Frameworks/Fixture Helper.app/Contents/MacOS/Fixture Helper';
  assert.deepEqual(
    await readFile(join(options.directory, 'Electron.app', relativeHelper)),
    await readFile(join(options.source, relativeHelper)),
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
  // macOS 15 上复制并重签的系统 sleep 可能在启动时崩溃。
  const source = join(dirname(options.directory), 'running-host.c');
  await writeFile(
    source,
    '#include <stdio.h>\n#include <unistd.h>\nint main(void) { puts("ready"); fflush(stdout); sleep(30); return 0; }\n',
  );
  await run('/usr/bin/cc', [source, '-o', options.executable]);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', options.executable]);
  const target = await prepareDevElectron(options);
  const child = spawn(target);
  t.after(async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  const signal = AbortSignal.timeout(10_000);
  const output = await Promise.race([
    once(child.stdout, 'data', { signal }).then(([data]) => data.toString()),
    once(child, 'exit', { signal }).then(([code, signal]) => {
      throw new Error(`测试宿主未就绪：${signal ?? code}`);
    }),
  ]);
  assert.equal(output.trim(), 'ready');
  assert.equal(await prepareDevElectron(options), target);
  const entitlementPath = join(options.directory, 'changed.plist');
  const existing = await readFile(
    new URL('../apps/desktop/build/entitlements.mac.plist', import.meta.url),
  );
  await writeFile(entitlementPath, Buffer.concat([existing, Buffer.from('\n')]));
  const alias = join(dirname(options.directory), 'prepared-alias');
  await symlink(options.directory, alias);
  const before = await stat(target);
  await assert.rejects(
    prepareDevElectron({ ...options, directory: alias, entitlementPath }),
    /先按 Cmd\+Q/,
  );
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

test('未签名的发行物整包补签，嵌套 Helper 同样获得调试权限', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const options = await fixture(t, { signed: false });
  const target = await prepareDevElectron(options);
  await run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    join(options.directory, 'Electron.app'),
  ]);
  const helper = join(
    options.directory,
    'Electron.app/Contents/Frameworks/Fixture Helper.app/Contents/MacOS/Fixture Helper',
  );
  for (const path of [target, helper]) {
    const { stdout } = await run('/usr/bin/codesign', ['-d', '--entitlements', '-', path]);
    assert.match(stdout, /com\.apple\.security\.cs\.debugger/);
  }
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
