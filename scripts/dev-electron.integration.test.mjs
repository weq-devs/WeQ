import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const { DEVELOPMENT_RELOAD_APPLY, DEVELOPMENT_RELOAD_STATUS } = await tsImport(
  '../apps/desktop/src/shared/development_reload.ts',
  import.meta.url,
);

const run = promisify(execFile);

test('真实 electron-vite 监听：成功后等待点击，连续构建合并，失败不重载，界面热更新照常', {
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'weq-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"type":"module","main":"out/main/index.js"}');
  await writeFile(join(root, 'index.html'), '<script type="module" src="/renderer.js"></script>');
  await writeFile(
    join(root, 'renderer.js'),
    'console.log("fixture"); if(import.meta.hot) import.meta.hot.accept();',
  );
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
    import {tsImport} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};
    const {createDevelopmentReload,successfulDevelopmentReload} = await tsImport(${JSON.stringify(new URL('../apps/desktop/src/main/development_reload.ts', import.meta.url).href)}, import.meta.url);
    const {developmentBuildSummary, developmentViteLogging} = await tsImport(${JSON.stringify(new URL('../apps/desktop/src/main/development_vite.ts', import.meta.url).href)}, import.meta.url);
    const summary = developmentBuildSummary();
    const mainLogging = developmentViteLogging('main', process.env, undefined, undefined, summary);
    const preloadLogging = developmentViteLogging('preload', process.env, undefined, undefined, summary);
    const reload = createDevelopmentReload();
    export default {
      main: {...mainLogging.config, plugins:[...mainLogging.plugins, successfulDevelopmentReload('main',reload)], build: {watch: ${JSON.stringify(watch.main)}, rollupOptions: {input: ${JSON.stringify(main)}}}},
      preload: {...preloadLogging.config, plugins:[...preloadLogging.plugins, successfulDevelopmentReload('preload',reload)], build: {watch: ${JSON.stringify(watch.preload)}, rollupOptions: {input: ${JSON.stringify(join(root, 'preload.js'))}}}},
      renderer: {root: ${JSON.stringify(root)}, plugins:[reload.rendererPlugin()], server: {host:'127.0.0.1',port:0}, build:{rollupOptions:{input:${JSON.stringify(join(root, 'index.html'))}}}}
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
  const client = await (await fetch(`${first.url}/@vite/client`)).text();
  const token = /const wsToken = "([^"]+)"/.exec(client)?.[1];
  const { default: WebSocket } = await import(pathToFileURL(require.resolve('ws')).href);
  const ws = new WebSocket(`${first.url.replace('http:', 'ws:')}/?token=${token}`, 'vite-hmr');
  t.after(() => ws.terminate());
  let pending = null;
  let reloads = 0;
  let updates = 0;
  const statuses = [];
  ws.on('message', (message) => {
    const data = JSON.parse(String(message));
    if (data.type === 'full-reload') reloads++;
    if (data.type === 'update') updates++;
    if (data.type === 'custom' && data.event === DEVELOPMENT_RELOAD_STATUS) {
      pending = data.data;
      statuses.push(pending);
    }
  });
  await once(ws, 'open');
  const apply = () =>
    ws.send(
      JSON.stringify({ type: 'custom', event: DEVELOPMENT_RELOAD_APPLY, data: { id: pending.id } }),
    );
  await writeFile(main, 'export const = ;');
  await until(() => /Expected|PARSE_ERROR|Unexpected/.test(output));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal((await starts()).length, 1, output);
  assert.match(output, /仍运行上次成功构建/);
  process.kill(first.pid, 0);
  await writeFile(main, source(2));
  await until(() => pending?.ready && pending.restart);
  const batch = pending.id;
  assert.equal((await starts()).length, 1, '成功构建不能自动重启');
  await writeFile(main, source(3));
  const previous = statuses.length;
  await until(() => statuses.length > previous && pending?.ready);
  assert.equal(pending.id, batch, '连续构建合为同一批');
  apply();
  await until(async () => (await starts()).length === 2);
  assert.equal((await starts())[1].value, 3);
  assert.equal((await starts())[1].restarting, '1');
  assert.match(output, /主进程增量构建完成（构建已恢复）/);
  output = '';
  await writeFile(join(root, 'preload.js'), 'export const = ;');
  await until(() => /Expected|PARSE_ERROR|Unexpected/.test(output));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(reloads, 0, '预加载构建失败不刷新正在运行的页面');
  await writeFile(join(root, 'preload.js'), 'export const value = 2;');
  await until(() => pending?.ready && !pending.restart);
  assert.equal(reloads, 0, '预加载成功也等待点击');
  apply();
  await until(() => reloads === 1);
  assert.equal(reloads, 1);
  assert.equal((await starts()).length, 2);
  await fetch(`${first.url}/renderer.js`);
  await writeFile(
    join(root, 'renderer.js'),
    'console.log("updated"); if(import.meta.hot) import.meta.hot.accept();',
  );
  await until(() => updates > 0);
  assert.equal(pending, null, '兼容热更新不弹重载提示');
  await writeFile(
    join(root, 'index.html'),
    '<title>updated</title><script type="module" src="/renderer.js"></script>',
  );
  await until(() => pending?.ready);
  assert.equal(reloads, 1, 'HTML 完整刷新先提示');
  apply();
  await until(() => reloads === 2);
});
