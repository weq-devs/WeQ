import { createServer } from 'node:net';
import { readFile, open, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { uptime } from 'node:os';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { writeFileAtomic } from '@weq/service/atomic-write';
import { z } from 'zod';
import { RecallJournal } from './recall_journal';
import { QqSyncProxy } from './proxy';
import { QQ_SYNC_CONTROL_VERSION, type SyncProxyConfig } from './ipc';

const suppliedPath = process.argv[process.argv.indexOf('--config') + 1];
if (!suppliedPath || process.argv.indexOf('--config') < 0) throw new Error('缺少代理配置');
const configPath: string = suppliedPath;
const config = JSON.parse(await readFile(configPath, 'utf8')) as SyncProxyConfig;
const directory = dirname(configPath);
const entry = fileURLToPath(import.meta.url);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function supervise() {
  const lockPath = join(directory, 'supervisor.json');
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch {
    let previous: { pid: number; bootTime?: number };
    try {
      previous = JSON.parse(await readFile(lockPath, 'utf8'));
    } catch {
      return;
    }
    if (previous.bootTime && Math.abs(previous.bootTime - (Date.now() - uptime() * 1000)) < 10000) {
      try {
        process.kill(previous.pid, 0);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
      }
    }
    await unlink(lockPath).catch(() => undefined);
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch {
      return;
    }
  }
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, bootTime: Date.now() - uptime() * 1000 }),
  );
  await lock.close();
  let stopped = false;
  let child: ReturnType<typeof spawn> | undefined;
  const stop = () => {
    stopped = true;
    child?.kill();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  let failures = 0;
  let deferListen = process.argv.includes('--defer-listen');
  try {
    while (!stopped) {
      const started = Date.now();
      const code = await new Promise<number | null>((resolve) => {
        const launched = spawn(
          process.execPath,
          [
            ...process.execArgv,
            entry,
            '--config',
            configPath,
            ...(deferListen ? ['--defer-listen'] : []),
          ],
          {
            stdio: 'ignore',
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          },
        );
        child = launched;
        deferListen = false;
        launched.once('error', () => resolve(1));
        launched.once('exit', resolve);
      });
      if (code === 0 || stopped) break;
      failures = Date.now() - started > 60000 ? 1 : failures + 1;
      await sleep(Math.min(30000, 500 * 2 ** Math.min(failures, 6)));
    }
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

const schema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status'), token: z.string() }),
  z.object({
    op: z.literal('listen'),
    token: z.string(),
    port: z.number().int().min(1).max(65535).optional(),
  }),
  z.object({ op: z.literal('set-enabled'), token: z.string(), enabled: z.boolean() }),
  z.object({
    op: z.literal('credential'),
    token: z.string(),
    value: z.object({
      uin: z.string(),
      key: z.string(),
      generation: z.string().max(128),
      selfUid: z.string().optional(),
    }),
  }),
  z.object({
    op: z.literal('recall-policy'),
    token: z.string(),
    uin: z.string(),
    generation: z.string(),
    value: z.object({
      owner: z.string().max(256),
      enabled: z.boolean(),
      block: z.boolean(),
      all: z.boolean(),
      targets: z
        .array(z.object({ kind: z.enum(['c2c', 'group', 'dataline']), id: z.string() }))
        .max(10000),
    }),
  }),
  z.object({
    op: z.literal('recall-events'),
    token: z.string(),
    uin: z.string(),
    generation: z.string(),
    ack: z.array(z.string()).max(64),
  }),
  z.object({ op: z.literal('live'), token: z.string(), uin: z.string(), generation: z.string() }),
  z.object({ op: z.literal('forget'), token: z.string(), uin: z.string() }),
  z.object({
    op: z.literal('push'),
    token: z.string(),
    uin: z.string(),
    generation: z.string().max(128),
    identity: z.string().max(512),
    body: z.string().max(12 * 1024 * 1024),
  }),
]);
async function serve() {
  const proxy = new QqSyncProxy(new RecallJournal(join(directory, 'recall-events')));
  const startedAt = Date.now();
  let listenError = '';
  let retryListen: ReturnType<typeof setInterval> | undefined;
  let pendingChange = Promise.resolve();
  let stopping = false;
  const status = () => ({
    ...proxy.status(),
    enabled: config.enabled !== false,
    pid: process.pid,
    port: config.port,
    error: listenError,
    protocolVersion: QQ_SYNC_CONTROL_VERSION,
  });
  const recordStatus = () =>
    writeFileAtomic(
      join(directory, 'status.json'),
      JSON.stringify({
        pid: process.pid,
        port: config.port,
        startedAt,
        state: config.enabled === false ? '已关闭' : proxy.status().running ? '正常' : '监听失败',
        error: listenError,
        protocolVersion: QQ_SYNC_CONTROL_VERSION,
      }),
    ).catch(() => undefined);
  function configure(
    change: Partial<Pick<SyncProxyConfig, 'enabled' | 'port'>>,
    requireEnabled = false,
  ) {
    const operation = pendingChange.then(async () => {
      if (stopping) throw new Error('QQ 同步代理正在退出');
      const port = change.port ?? config.port;
      const enabled = change.enabled ?? config.enabled !== false;
      if (requireEnabled && !enabled) throw new Error('QQ 代理已关闭');
      const changed = port !== config.port || enabled !== (config.enabled !== false);
      if (!changed && enabled === proxy.status().running) return { port };
      const persist = () =>
        writeFileAtomic(configPath, JSON.stringify({ ...config, port, enabled }));
      try {
        if (enabled && (!proxy.status().running || port !== config.port))
          await proxy.start(port, changed ? persist : undefined);
        else if (changed) await persist();
      } catch (error) {
        const cause = error as NodeJS.ErrnoException;
        const message =
          cause.code === 'EADDRINUSE'
            ? `本机端口 ${port} 已被占用，请选择其他端口`
            : `无法使用本机端口 ${port}：${cause.message}`;
        if (
          enabled &&
          config.enabled !== false &&
          port === config.port &&
          !proxy.status().running &&
          listenError !== message
        ) {
          listenError = message;
          await recordStatus();
        }
        throw new Error(message);
      }
      config.port = port;
      config.enabled = enabled;
      if (!enabled) await proxy.close();
      listenError = '';
      clearInterval(retryListen);
      await recordStatus();
      return { port };
    });
    pendingChange = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  const server = createServer((socket) => {
    let buffer = '';
    const timer = setTimeout(() => socket.destroy(), 10000);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => clearTimeout(timer));
    socket.on('data', async (data) => {
      buffer += data.toString();
      if (buffer.length > 13 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      if (!buffer.includes('\n')) return;
      socket.removeAllListeners('data');
      clearTimeout(timer);
      try {
        const request = schema.parse(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))));
        const supplied = Buffer.from(request.token);
        const expected = Buffer.from(config.token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
          throw Error('代理认证失败');
        let result: unknown;
        if (request.op === 'status') result = status();
        else if (request.op === 'listen')
          result = await configure({ port: request.port }, request.port === undefined);
        else if (request.op === 'set-enabled')
          result = await configure({ enabled: request.enabled });
        else if (config.enabled === false) throw new Error('QQ 代理已关闭');
        else if (request.op === 'live') {
          proxy.subscribeLive(request.uin, request.generation, socket);
          return;
        } else if (request.op === 'credential') {
          proxy.setCredential(request.value);
          result = true;
        } else if (request.op === 'recall-policy') {
          proxy.setRecallPolicy(request.uin, request.generation, request.value);
          result = true;
        } else if (request.op === 'recall-events') {
          result = proxy.takeRecallEvents(request.uin, request.generation, request.ack);
        } else if (request.op === 'forget') {
          proxy.forget(request.uin);
          result = true;
        } else
          result = await proxy.deliver(
            request.uin,
            request.generation,
            request.identity,
            Buffer.from(request.body, 'base64'),
          );
        socket.end(`${JSON.stringify({ ok: true, result })}\n`);
      } catch (error) {
        socket.end(
          `${JSON.stringify({ ok: false, error: error instanceof z.ZodError ? '代理请求无效' : (error as Error).message })}\n`,
        );
      }
    });
  });
  // 监护进程串行启动子进程，此处清理上一代退出后留下的 Unix socket。
  if (process.platform !== 'win32') await unlink(config.socket).catch(() => undefined);
  // 端口占用时仍开放私有控制通道，供设置页改到可用端口。
  if (!process.argv.includes('--defer-listen') && config.enabled !== false) {
    await configure({}).catch(() => {
      retryListen = setInterval(() => void configure({}).catch(() => undefined), 5000).unref();
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.socket, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  if (process.platform !== 'win32')
    await import('node:fs/promises').then((fs) => fs.chmod(config.socket, 0o600));
  const stop = async () => {
    stopping = true;
    clearInterval(retryListen);
    await pendingChange;
    await proxy.close();
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
}
if (process.argv.includes('--supervise')) await supervise();
else
  await serve().catch(async (error) => {
    await writeFile(
      join(directory, 'failure.json'),
      JSON.stringify({
        time: Date.now(),
        code: (error as NodeJS.ErrnoException).code ?? 'start-failed',
      }),
      { mode: 0o600 },
    );
    process.exit(1);
  });
