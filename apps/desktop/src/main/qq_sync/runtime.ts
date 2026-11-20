import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveChildWorkerPath } from '../worker_path';
import {
  requestProxy,
  type SyncProxyConfig,
  type SyncProxyRequest,
  type SyncProxyStatus,
} from './ipc';

const starting = new Map<string, Promise<SyncProxyConfig>>();
const moduleDir = dirname(fileURLToPath(import.meta.url));
async function readConfig(root: string): Promise<SyncProxyConfig> {
  const directory = join(root, 'qq-client-sync');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'config.json');
  try {
    return JSON.parse(await readFile(path, 'utf8')) as SyncProxyConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const suffix = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const config: SyncProxyConfig = {
    port: 19081,
    token: randomBytes(32).toString('hex'),
    socket:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\weq-qq-sync-${suffix}`
        : join(tmpdir(), `weq-qq-sync-${suffix}.sock`),
  };
  try {
    await writeFile(path, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return JSON.parse(await readFile(path, 'utf8'));
  }
}

export async function ensureQqSyncProxy(root: string): Promise<SyncProxyConfig> {
  const prior = starting.get(root);
  if (prior) return prior;
  const promise = (async () => {
    const config = await readConfig(root);
    try {
      const status = await requestProxy<SyncProxyStatus>(config, { op: 'status' }, 1000);
      if ((status.protocolVersion ?? 1) >= 2) return config;
      if (!Number.isSafeInteger(status.pid) || status.pid <= 1)
        throw new Error('旧代理进程信息无效');
      await writeFile(
        join(root, 'qq-client-sync', 'status.json'),
        JSON.stringify({
          pid: status.pid,
          port: config.port,
          state: '维护中',
          reason: '升级防撤回代理',
          updatedAt: Date.now(),
        }),
        { mode: 0o600 },
      );
      process.kill(status.pid, 'SIGTERM');
      // 旧监护进程在正常退出时释放锁，随后再启动新版。
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          process.kill(status.pid, 0);
        } catch {
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch {
      /* 继续检查监护进程。 */
    }
    const entry = resolveChildWorkerPath('qqSyncWorker.mjs', moduleDir);
    const child = spawn(
      process.execPath,
      [entry, '--supervise', '--config', join(root, 'qq-client-sync', 'config.json')],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    );
    const launched = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    await launched;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        await requestProxy(config, { op: 'status' }, 500);
        return config;
      } catch {
        /* 启动中。 */
      }
    }
    throw new Error(`QQ 同步代理未就绪，请检查本机 ${config.port} 端口是否被占用`);
  })();
  starting.set(root, promise);
  try {
    return await promise;
  } finally {
    starting.delete(root);
  }
}

export async function qqSyncRequest<T>(root: string, request: SyncProxyRequest): Promise<T> {
  return requestProxy<T>(await ensureQqSyncProxy(root), request);
}
export async function qqSyncStatus(root: string) {
  try {
    const config = await readConfig(root);
    const status = await requestProxy<SyncProxyStatus>(config, { op: 'status' }, 1000);
    return { ...status, port: config.port, error: '' };
  } catch (error) {
    return {
      running: false,
      port: 19081,
      accounts: [] as string[],
      tunnels: 0,
      delivered: 0,
      pid: 0,
      error: (error as Error).message,
    };
  }
}
