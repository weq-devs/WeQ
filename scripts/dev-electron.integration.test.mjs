import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { acquireProcessLock, exists } from './dev-prepare.mjs';
import { runDevelopment } from './dev.mjs';

const { DEVELOPMENT_RELOAD_APPLY, DEVELOPMENT_RELOAD_STATUS } = await tsImport(
  '../apps/desktop/src/shared/development_reload.ts',
  import.meta.url,
);
const { DEVELOPMENT_RESTART_EXIT_CODE } = await tsImport(
  '../apps/desktop/src/main/development_restart.ts',
  import.meta.url,
);

const { publishDevelopmentWindow } = await tsImport(
  '../apps/desktop/src/main/development_window.ts',
  import.meta.url,
);

const run = promisify(execFile);
const eventTimeout = 10_000;
// Windows runner 的首次构建和宿主启动有独立预算，后续热更新仍使用事件超时。
const firstStartTimeout = process.platform === 'win32' ? 30_000 : eventTimeout;

test('真实 electron-vite：菜单和开发更新都在原 Vite 会话中重启 Electron', {
  timeout: firstStartTimeout + 20_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'weq-watch-'));
  let child;
  let ws;
  t.after(async () => {
    try {
      ws?.terminate();
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else await run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        await closed;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await writeFile(join(root, 'package.json'), '{"type":"module","main":"out/main/index.js"}');
  await writeFile(join(root, 'index.html'), '<script type="module" src="/renderer.js"></script>');
  await writeFile(
    join(root, 'renderer.js'),
    'console.log("fixture"); if(import.meta.hot) import.meta.hot.accept();',
  );
  const log = join(root, 'started.jsonl');
  const menuRestart = join(root, 'menu-restart');
  const lazyRequest = join(root, 'lazy-request');
  const lazyResult = join(root, 'lazy-result');
  const lazy = join(root, 'lazy.js');
  const main = join(root, 'main.js');
  const source = (value) =>
    `import {appendFileSync,existsSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs';
      const request = ${JSON.stringify(menuRestart)};
      const readLazy = ${JSON.stringify(lazyRequest)};
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({
        value:${value},pid:process.pid,parent:process.ppid,url:process.env.ELECTRON_RENDERER_URL,
        restarting:process.env.WEQ_DEV_RESTART,managed:process.env.WEQ_DEV_RESTART_MANAGED,
        args:process.argv.slice(2)
      })+'\\n');
      setInterval(async()=>{
        if (existsSync(readLazy)) {
          unlinkSync(readLazy);
          const value = await import('./lazy.js').then((mod) => mod.value, (error) => error.code);
          writeFileSync(${JSON.stringify(lazyResult)}, value);
        }
        if (!existsSync(request)) return;
        const code = Number.parseInt(readFileSync(request,'utf8'), 10);
        if (!Number.isInteger(code)) return;
        unlinkSync(request);
        process.exit(code);
      },25);`;
  await writeFile(lazy, 'export const value = "old-chunk";');
  await writeFile(main, source(1));
  await writeFile(join(root, 'preload.js'), 'export const value = 1;');
  const staleChunk = join(root, 'out/main/chunks/previous-session.js');
  await mkdir(join(root, 'out/main/chunks'), { recursive: true });
  await writeFile(staleChunk, 'export {}');
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
    const {createDevelopmentReload,retainDevelopmentMainChunks,successfulDevelopmentReload} = await tsImport(${JSON.stringify(new URL('../apps/desktop/src/main/development_reload.ts', import.meta.url).href)}, import.meta.url);
    const {developmentBuildSummary, developmentViteLogging} = await tsImport(${JSON.stringify(new URL('../apps/desktop/src/main/development_vite.ts', import.meta.url).href)}, import.meta.url);
    const summary = developmentBuildSummary();
    const mainLogging = developmentViteLogging('main', process.env, undefined, undefined, summary);
    const preloadLogging = developmentViteLogging('preload', process.env, undefined, undefined, summary);
    const reload = createDevelopmentReload();
    export default {
      main: {...mainLogging.config, plugins:[...mainLogging.plugins, retainDevelopmentMainChunks(), successfulDevelopmentReload('main',reload)], build: {watch: ${JSON.stringify(watch.main)}, rollupOptions: {input: ${JSON.stringify(main)}}}},
      preload: {...preloadLogging.config, plugins:[...preloadLogging.plugins, successfulDevelopmentReload('preload',reload)], build: {watch: ${JSON.stringify(watch.preload)}, rollupOptions: {input: ${JSON.stringify(join(root, 'preload.js'))}}}},
      renderer: {root: ${JSON.stringify(root)}, plugins:[reload.rendererPlugin({clearOnMenuRestart:true})], server: {host:'127.0.0.1',port:0}, build:{rollupOptions:{input:${JSON.stringify(join(root, 'index.html'))}}}}
    };
  `,
  );
  const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
  const runner = fileURLToPath(new URL('./run-dev-electron.mjs', import.meta.url));
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
  child = spawn(process.execPath, [runner, '--', '--user-data-dir=fixture', '--weq-autostart'], {
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
  const until = async (check, timeout = eventTimeout, event = '监听事件') => {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      if (await check()) return;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `等待${event}时开发进程退出（${child.exitCode ?? child.signalCode}）：${output}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`等待${event}超时（${timeout}ms）：${output || '开发进程尚无输出'}`);
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
  await until(async () => (await starts()).length === 1, firstStartTimeout, '首次构建和宿主启动');
  await assert.rejects(readFile(staleChunk), { code: 'ENOENT' });
  const first = (await starts())[0];
  assert.equal(first.restarting, undefined);
  assert.equal(first.managed, '1');
  assert.deepEqual(first.args, ['--user-data-dir=fixture', '--weq-autostart']);
  assert.match(output, /初始构建完成/);
  assert.doesNotMatch(output, /watching for file changes|build started|built in \d+ms/);
  const client = await (await fetch(`${first.url}/@vite/client`)).text();
  const token = /const wsToken = "([^"]+)"/.exec(client)?.[1];
  const { default: WebSocket } = await import(pathToFileURL(require.resolve('ws')).href);
  ws = new WebSocket(`${first.url.replace('http:', 'ws:')}/?token=${token}`, 'vite-hmr');
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
  await writeFile(lazy, 'export const value = "new-chunk";');
  await writeFile(main, source(2));
  await until(() => pending?.ready && pending.restart);
  const batch = pending.id;
  assert.equal((await starts()).length, 1, '成功构建不能自动重启');
  const readLazy = async () => {
    await rm(lazyResult, { force: true });
    await writeFile(lazyRequest, '');
    let value;
    await until(async () => {
      try {
        value = await readFile(lazyResult, 'utf8');
        return Boolean(value);
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    });
    return value;
  };
  assert.equal(await readLazy(), 'old-chunk', '待重启期间旧进程仍能加载旧分块');
  await writeFile(main, source(3));
  const previous = statuses.length;
  await until(() => statuses.length > previous && pending?.ready);
  assert.equal(pending.id, batch, '连续构建合为同一批');
  apply();
  await until(async () => (await starts()).length === 2);
  assert.equal((await starts())[1].value, 3);
  assert.equal((await starts())[1].restarting, '1');
  assert.equal(await readLazy(), 'new-chunk', '重启后按需加载新分块');
  assert.match(output, /主进程增量构建完成（构建已恢复）/);
  await writeFile(main, source(4));
  await until(() => pending?.ready && pending.restart);
  await writeFile(menuRestart, String(DEVELOPMENT_RESTART_EXIT_CODE));
  await until(async () => (await starts()).length === 3 && pending === null);
  const [, hot, manual] = await starts();
  assert.equal(hot.url, first.url);
  assert.equal(manual.url, first.url);
  assert.equal(hot.parent, first.parent);
  assert.equal(manual.parent, first.parent);
  assert.equal(new Set([first.pid, hot.pid, manual.pid]).size, 3);
  assert.equal(manual.value, 4);
  assert.equal(manual.restarting, '1');
  assert.deepEqual(manual.args, ['--user-data-dir=fixture', '--weq-manual-restart']);
  assert.match(output, /正在重启 WeQ 应用/);
  assert.equal(output.match(/初始构建完成/g).length, 1);
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
  assert.equal((await starts()).length, 3);
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
  const closed = once(child, 'close');
  await writeFile(menuRestart, '0');
  assert.deepEqual(await closed, [0, null], output);
  assert.equal((await starts()).length, 3);
});

test('已退出会话的窗口控制端点不会重建启动锁', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'weq-dev-window-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const lock = join(repo, '.weq-dev/running');
  const release = await acquireProcessLock(lock);
  await release();
  const endpoint = join(lock, 'window-previous.json');
  await assert.rejects(
    async () => {
      const close = await publishDevelopmentWindow(endpoint, async () => true);
      close();
    },
    { code: 'ENOENT' },
  );
  assert.equal(await exists(lock), false);
  const releaseNext = await acquireProcessLock(lock);
  await releaseNext();
});

test('重复启动等候开发版就绪，每次请求只在当前会话新开一个窗口', {
  timeout: 10_000,
}, async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'weq-dev-window-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const launched = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const waiting = Promise.withResolvers();
  let prepares = 0;
  const silent = () => {};
  const options = {
    repo,
    args: ['--', '--enable-dress-tools'],
    unused: silent,
    dependencies: () => {
      prepares++;
    },
    electron: silent,
    native: silent,
    network: silent,
    bot: silent,
    log: silent,
    launch: async (_args, env) => {
      launched.resolve(env.WEQ_DEV_WINDOW_ENDPOINT);
      await finish.promise;
      return 0;
    },
  };
  const first = runDevelopment(options);
  let close;
  let second;
  try {
    const endpointPath = await Promise.race([launched.promise, first]);
    second = runDevelopment({ ...options, log: waiting.resolve });
    // 等第二次运行实际进入等待，再发布开发版的控制地址。
    await Promise.race([waiting.promise, second]);
    assert.equal(await exists(endpointPath), false);
    await assert.rejects(
      runDevelopment({ ...options, args: ['--', '--user-data-dir=/other'] }),
      /已在运行/,
    );
    let opened = 0;
    close = await publishDevelopmentWindow(endpointPath, async () => {
      opened++;
      return true;
    });
    await second;
    assert.equal(opened, 1);
    await runDevelopment({ ...options, args: [] });
    assert.equal(opened, 2);
    assert.equal(prepares, 1);
  } finally {
    close?.();
    finish.resolve();
    await Promise.allSettled([first, second]);
  }
  await first;
});
