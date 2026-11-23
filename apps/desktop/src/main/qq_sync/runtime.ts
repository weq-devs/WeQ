import { connect } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
const enabledByRoot = new Map<string, { enabled: boolean; expiresAt: number }>();
const moduleDir = dirname(fileURLToPath(import.meta.url));
const runCommand = promisify(execFile);

export function isQqSyncProxyEnabled(root: string): boolean {
  const now = Date.now();
  const cached = enabledByRoot.get(root);
  if (cached && cached.expiresAt > now) return cached.enabled;
  let enabled = false;
  try {
    const config: SyncProxyConfig = JSON.parse(
      readFileSync(join(root, 'qq-client-sync', 'config.json'), 'utf8'),
    );
    // 已配置旧版代理的宿主继续转发。首次使用需显式开启。
    enabled = config.enabled !== false;
  } catch {
    // 具体配置错误由状态查询和设置操作报告。
  }
  // 其他账号窗口也能修改同一配置，实时推送不必每帧同步读盘。
  enabledByRoot.set(root, { enabled, expiresAt: now + 1000 });
  return enabled;
}

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
    enabled: false,
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

async function stopWindowsSupervisor(root: string, workerPid: number): Promise<void> {
  const directory = join(root, 'qq-client-sync');
  let supervisor: { pid: number };
  try {
    supervisor = JSON.parse(await readFile(join(directory, 'supervisor.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!Number.isSafeInteger(supervisor.pid) || supervisor.pid <= 1)
    throw new Error('旧代理监护进程信息无效');
  const script =
    "$ErrorActionPreference='Stop';" +
    `$worker=Get-CimInstance Win32_Process -Filter 'ProcessId = ${workerPid}';` +
    `if ($null -eq $worker -or $worker.ParentProcessId -ne ${supervisor.pid}) { return };` +
    `$parent=Get-CimInstance Win32_Process -Filter 'ProcessId = ${supervisor.pid}';` +
    'if ($null -eq $parent) { return };' +
    "if ($parent.CommandLine -notmatch 'qqSyncWorker\\.mjs.*\\s--supervise\\s' -or " +
    '$parent.CommandLine.IndexOf($env:WEQ_QQ_SYNC_CONFIG_PATH, [StringComparison]::OrdinalIgnoreCase) -lt 0) ' +
    "{ throw '无法确认旧代理监护进程身份' };" +
    'Stop-Process -Id $parent.ProcessId -Force';
  await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, WEQ_QQ_SYNC_CONFIG_PATH: join(directory, 'config.json') },
    timeout: 5000,
    windowsHide: true,
  });
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
      // Windows 的终止信号会直接结束子进程。先停止监护，避免它立即拉起旧版本。
      if (process.platform === 'win32') await stopWindowsSupervisor(root, status.pid);
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
        ...(deferListen ? ['--defer-listen'] : []),
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
  if (!isQqSyncProxyEnabled(root)) throw new Error('QQ 代理已关闭');
  const { config, status } = await ensureQqSyncController(root);
  if (status.running) return { ...config, port: status.port ?? config.port };
  const { port } = await requestProxy<{ port: number }>(config, { op: 'listen' });
  return { ...config, port };
}

export async function setQqSyncProxyEnabled(root: string, enabled: boolean): Promise<void> {
  const { config } = await ensureQqSyncController(root, true);
  try {
    await requestProxy(config, { op: 'set-enabled', enabled });
  } finally {
    enabledByRoot.delete(root);
    isQqSyncProxyEnabled(root);
  }
}

export async function setQqSyncPort(root: string, port: number): Promise<{ port: number }> {
  const { config } = await ensureQqSyncController(root, true);
  return requestProxy(config, { op: 'listen', port });
}

export async function qqSyncRequest<T>(root: string, request: SyncProxyRequest): Promise<T> {
  return requestProxy<T>(await ensureQqSyncProxy(root), request);
}
/** Event-driven control socket. Returning closes it and lets the account loop reconnect. */
export async function subscribeQqLive(
  root: string,
  uin: string,
  generation: string,
  signal: AbortSignal,
  onPush: (body: Buffer) => void,
): Promise<void> {
  if (signal.aborted) return;
  const config = await ensureQqSyncProxy(root);
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const socket = connect({ path: config.socket, signal });
    let pending = '';
    socket.on('error', () => socket.destroy());
    socket.once('close', resolve);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ op: 'live', token: config.token, uin, generation })}\n`);
    });
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => {
      pending += data;
      if (pending.length > 1024 * 1024) return socket.destroy();
      let end = pending.indexOf('\n');
      while (end !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const message = JSON.parse(line) as { body?: string };
          if (typeof message.body !== 'string') return socket.destroy();
          onPush(Buffer.from(message.body, 'base64'));
        } catch {
          return socket.destroy();
        }
        end = pending.indexOf('\n');
      }
    });
  });
}

export async function qqSyncStatus(root: string) {
  let port = DEFAULT_QQ_SYNC_PORT;
  let enabled = false;
  let error = '';
  try {
    const config = await loadConfig(root);
    if (config) {
      port = config.port;
      enabled = config.enabled !== false;
      const status = await requestProxy<SyncProxyStatus>(config, { op: 'status' }, 1000);
      return {
        ...status,
        enabled: status.enabled ?? enabled,
        port: status.port ?? port,
        error: status.error ?? '',
      };
    }
  } catch (cause) {
    const failure = cause as NodeJS.ErrnoException;
    const unavailable = ['ENOENT', 'ECONNREFUSED'].includes(failure.code ?? '');
    error = unavailable ? (enabled ? 'QQ 同步代理尚未启动' : '') : failure.message;
  }
  return {
    running: false,
    enabled,
    port,
    accounts: [] as string[],
    tunnels: 0,
    connecting: false,
    delivered: 0,
    pid: 0,
    error,
  };
}
