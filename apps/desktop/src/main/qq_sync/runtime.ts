import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveChildWorkerPath } from '../worker_path';
import {
  DEFAULT_QQ_SYNC_PORT,
  QQ_SYNC_CONTROL_VERSION,
  requestProxy,
  type SyncProxyConfig,
  type SyncProxyRequest,
  type SyncProxyStatus,
} from './ipc';

const starting = new Map<string, Promise<{ config: SyncProxyConfig; status: SyncProxyStatus }>>();
const moduleDir = dirname(fileURLToPath(import.meta.url));
async function loadConfig(root: string): Promise<SyncProxyConfig | undefined> {
  try {
    return JSON.parse(await readFile(join(root, 'qq-client-sync', 'config.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

async function ensureConfig(root: string): Promise<SyncProxyConfig> {
  const existing = await loadConfig(root);
  if (existing) return existing;
  const directory = join(root, 'qq-client-sync');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'config.json');
  const suffix = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const config: SyncProxyConfig = {
    port: DEFAULT_QQ_SYNC_PORT,
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

async function ensureQqSyncController(root: string, deferListen = false) {
  const prior = starting.get(root);
  if (prior) return prior;
  const promise = (async () => {
    const config = await ensureConfig(root);
    const readStatus = () => requestProxy<SyncProxyStatus>(config, { op: 'status' }, 1000);
    const status = await readStatus().catch(() => undefined);
    if (status && (status.protocolVersion ?? 1) >= QQ_SYNC_CONTROL_VERSION)
      return { config, status };
    const entry = resolveChildWorkerPath('qqSyncWorker.mjs', moduleDir);
    if (status) {
      if (!Number.isSafeInteger(status.pid) || status.pid <= 1)
        throw new Error('旧代理进程信息无效');
      await writeFile(
        join(root, 'qq-client-sync', 'status.json'),
        JSON.stringify({
          pid: status.pid,
          port: config.port,
          state: '维护中',
          reason: '升级 QQ 同步代理',
          updatedAt: Date.now(),
        }),
        { mode: 0o600 },
      );
      try {
        process.kill(status.pid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
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
    }
    const child = spawn(
      process.execPath,
      [
        entry,
        '--supervise',
        '--config',
        join(root, 'qq-client-sync', 'config.json'),
        ...(deferListen && !status ? ['--defer-listen'] : []),
      ],
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
      const current = await readStatus().catch(() => undefined);
      if (current && (current.protocolVersion ?? 1) >= QQ_SYNC_CONTROL_VERSION)
        return { config, status: current };
    }
    throw new Error(status ? 'QQ 同步代理升级后未就绪' : 'QQ 同步代理控制进程未就绪');
  })();
  starting.set(root, promise);
  try {
    return await promise;
  } finally {
    starting.delete(root);
  }
}

export async function ensureQqSyncProxy(root: string): Promise<SyncProxyConfig> {
  const { config, status } = await ensureQqSyncController(root);
  if (status.running) return { ...config, port: status.port ?? config.port };
  const { port } = await requestProxy<{ port: number }>(config, { op: 'listen' });
  return { ...config, port };
}

export async function setQqSyncPort(root: string, port: number): Promise<{ port: number }> {
  const { config } = await ensureQqSyncController(root, true);
  return requestProxy(config, { op: 'listen', port });
}

export async function qqSyncRequest<T>(root: string, request: SyncProxyRequest): Promise<T> {
  return requestProxy<T>(await ensureQqSyncProxy(root), request);
}
export async function qqSyncStatus(root: string) {
  let port = DEFAULT_QQ_SYNC_PORT;
  let error = '';
  try {
    const config = await loadConfig(root);
    if (config) {
      port = config.port;
      const status = await requestProxy<SyncProxyStatus>(config, { op: 'status' }, 1000);
      return { ...status, port: status.port ?? port, error: status.error ?? '' };
    }
  } catch (cause) {
    const failure = cause as NodeJS.ErrnoException;
    error = ['ENOENT', 'ECONNREFUSED'].includes(failure.code ?? '')
      ? 'QQ 同步代理尚未启动'
      : failure.message;
  }
  return {
    running: false,
    port,
    accounts: [] as string[],
    tunnels: 0,
    connecting: false,
    delivered: 0,
    pid: 0,
    error,
  };
}
