import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareDevElectron } from './prepare-dev-electron.mjs';

const run = promisify(execFile);

test('真实 electron-vite 监听：主进程成功才重启，语法错误保留旧进程，预加载只通知刷新', {
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'weq-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"type":"module","main":"out/main/index.js"}');
  await writeFile(join(root, 'index.html'), '<script type="module" src="/renderer.js"></script>');
  await writeFile(join(root, 'renderer.js'), 'console.log("fixture");');
  const log = join(root, 'started.jsonl');
  const main = join(root, 'main.js');
  const source = (value) =>
    `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(log)}, JSON.stringify({value:${value},pid:process.pid,url:process.env.ELECTRON_RENDERER_URL,restarting:process.env.WEQ_DEV_RESTART})+'\\n'); setInterval(()=>{},1000);`;
  await writeFile(main, source(1));
  await writeFile(join(root, 'preload.js'), 'export const value = 1;');
  const { stdout } = await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {loadConfigFromFile} from 'electron-vite';
    process.env.NODE_ENV_ELECTRON_VITE = 'development';
    const {config} = await loadConfigFromFile({command:'serve',mode:'development'});
    console.log(JSON.stringify({main:config.main.build.watch,preload:config.preload.build.watch}));
  `,
    ],
    {
      cwd: fileURLToPath(new URL('../apps/desktop', import.meta.url)),
      env: { ...process.env, WEQ_DEV_CONSOLE: '0' },
    },
  );
  const watch = JSON.parse(stdout);
  await writeFile(
    join(root, 'electron.vite.config.mjs'),
    `
    import {successfulDevelopmentReload} from ${JSON.stringify(fileURLToPath(new URL('../apps/desktop/src/main/development_reload.ts', import.meta.url)))};
    import {tsImport} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};
    const {developmentBuildSummary, developmentViteLogging} = await tsImport(${JSON.stringify(fileURLToPath(new URL('../apps/desktop/src/main/development_vite.ts', import.meta.url)))}, import.meta.url);
    const summary = developmentBuildSummary();
    const mainLogging = developmentViteLogging('main', process.env, undefined, undefined, summary);
    const preloadLogging = developmentViteLogging('preload', process.env, undefined, undefined, summary);
    export default {
      main: {...mainLogging.config, plugins:[...mainLogging.plugins, successfulDevelopmentReload('main')], build: {watch: ${JSON.stringify(watch.main)}, rollupOptions: {input: ${JSON.stringify(main)}}}},
      preload: {...preloadLogging.config, plugins:[...preloadLogging.plugins, successfulDevelopmentReload('preload')], build: {watch: ${JSON.stringify(watch.preload)}, rollupOptions: {input: ${JSON.stringify(join(root, 'preload.js'))}}}},
      renderer: {root: ${JSON.stringify(root)}, server: {host:'127.0.0.1',port:0}, build:{rollupOptions:{input:${JSON.stringify(join(root, 'index.html'))}}}}
    };
  `,
  );
  const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
  const pkg = require.resolve('electron-vite/package.json');
  const manifest = JSON.parse(await readFile(pkg, 'utf8'));
  const bin = join(dirname(pkg), manifest.bin['electron-vite']);
  const env = {
    ...process.env,
    ELECTRON_EXEC_PATH: process.execPath,
    ELECTRON_MAJOR_VER: '44',
    ELECTRON_ENTRY: join(root, 'out/main/main.js'),
    WEQ_DEV_CONSOLE: '1',
    WEQ_LOG_LEVEL: 'info',
  };
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_CLI_ARGS',
    'REMOTE_DEBUGGING_PORT',
    'V8_INSPECTOR_PORT',
    'V8_INSPECTOR_BRK_PORT',
    'NO_SANDBOX',
    'WEQ_DEV_RESTART',
  ])
    delete env[key];
  const child = spawn(process.execPath, [bin, 'dev'], {
    cwd: root,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else child.kill();
      await closed;
    }
  });
  const until = async (check) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      if (child.exitCode !== null) throw new Error(output);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`等待监听事件超时：${output}`);
  };
  const starts = async () => {
    try {
      return (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  await until(async () => (await starts()).length === 1);
  const first = (await starts())[0];
  assert.equal(first.restarting, undefined);
  assert.match(output, /初始构建完成/);
  assert.doesNotMatch(output, /watching for file changes|build started|built in \d+ms/);
  await writeFile(main, 'export const = ;');
  await until(() => /Expected|PARSE_ERROR|Unexpected/.test(output));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal((await starts()).length, 1, output);
  assert.match(output, /仍运行上次成功构建/);
  process.kill(first.pid, 0);
  await writeFile(main, source(2));
  await until(async () => (await starts()).length === 2);
  assert.equal((await starts())[1].value, 2);
  assert.equal((await starts())[1].restarting, '1');
  assert.match(output, /主进程增量构建完成（构建已恢复）/);
  const client = await (await fetch(`${first.url}/@vite/client`)).text();
  const token = /const wsToken = "([^"]+)"/.exec(client)?.[1];
  const { default: WebSocket } = await import(pathToFileURL(require.resolve('ws')).href);
  const ws = new WebSocket(`${first.url.replace('http:', 'ws:')}/?token=${token}`, 'vite-hmr');
  t.after(() => ws.terminate());
  await once(ws, 'open');
  output = '';
  let reloads = 0;
  ws.on('message', (message) => {
    if (JSON.parse(String(message)).type === 'full-reload') reloads++;
  });
  await writeFile(join(root, 'preload.js'), 'export const = ;');
  await until(() => /Expected|PARSE_ERROR|Unexpected/.test(output));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(reloads, 0, '预加载构建失败不刷新正在运行的页面');
  const refreshed = new Promise((resolve) =>
    ws.on('message', (message) => {
      if (JSON.parse(String(message)).type === 'full-reload') resolve();
    }),
  );
  await writeFile(join(root, 'preload.js'), 'export const value = 2;');
  await refreshed;
  assert.equal(reloads, 1);
  assert.equal((await starts()).length, 2);
});

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
