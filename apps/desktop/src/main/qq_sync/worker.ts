import { createServer } from 'node:net';
import { readFile, open, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { uptime } from 'node:os';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { QqSyncProxy } from './proxy';
import type { SyncProxyConfig } from './ipc';

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
  try {
    while (!stopped) {
      const started = Date.now();
      const code = await new Promise<number | null>((resolve) => {
        const launched = spawn(
          process.execPath,
          [...process.execArgv, entry, '--config', configPath],
          {
            stdio: 'ignore',
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          },
        );
        child = launched;
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
    op: z.literal('credential'),
    token: z.string(),
    value: z.object({ uin: z.string(), key: z.string(), generation: z.string().max(128) }),
  }),
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
  const proxy = new QqSyncProxy();
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
        if (request.op === 'status') result = { ...proxy.status(), pid: process.pid };
        else if (request.op === 'credential') {
          proxy.setCredential(request.value);
          result = true;
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
  await proxy.start(config.port);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.socket, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  if (process.platform !== 'win32')
    await import('node:fs/promises').then((fs) => fs.chmod(config.socket, 0o600));
  await writeFile(
    join(directory, 'status.json'),
    JSON.stringify({ pid: process.pid, port: config.port, startedAt: Date.now() }),
    { mode: 0o600 },
  );
  const stop = async () => {
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
