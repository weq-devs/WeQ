/**
 * 提权抓包的**主进程半边** —— 用 `sudo -S` 起一个 root 子进程持有抓包会话。
 *
 * 为什么不能在本进程提权：Electron 拒绝以 root 运行，而抓包（原始套接字）必须要
 * euid=0 或 CAP_NET_RAW。所以只有「抓包会话」这一段进 root 子进程，主进程通过
 * `capture_protocol.ts` 的环回套接字协议代理前端的 start / take / stop。子进程里
 * 的实现在 `capture_worker.ts`。
 *
 * 密码来源：渲染层自绘的密码框（macOS 姿势的 `sudo -S`，不走 polkit）。**先非交互探测
 * 一次**（`sudo -n true`）——刚刚「读 QQ 内存」那条链路已经 sudo 过的话，凭据还在缓存里，
 * 这时就不再弹第二个框白让人输一遍。
 *
 * 生命周期：一次抓包会话一个子进程。`dispose()` 杀掉它；主进程自己退出时环回连接断开，
 * 子进程会自己停掉会话再退出（见 capture_worker 的 shutdown），不留后台 root 抓包。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linuxSudoErrorHint, resolveSudoPath } from '@weq/native';
import { getLogger } from '@weq/service';
import { requestSudoPassword } from './sudo_prompt';
import type {
  CaptureWorkerHello,
  CaptureWorkerReply,
  CaptureWorkerRequest,
} from './capture_protocol';

const logger = getLogger().child({ scope: 'capture-elevation' });

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 等 hello 的上限：sudo 认证 + native 加载。 */
const HELLO_TIMEOUT_MS = 30_000;
/** 单条请求的默认上限（`take` 会自带 waitMs，另算）。 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Locate the bundled `captureWorker.mjs`. electron-vite emits it next to the main
 * entry (`out/main/`), but this module may be chunked into `out/main/chunks/`,
 * so try the sibling path first, then one level up.
 */
function resolveWorkerPath(): string {
  const candidates = [
    join(__dirname, 'captureWorker.mjs'),
    join(__dirname, '..', 'captureWorker.mjs'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

/** 一个已起好的提权抓包子进程。 */
export interface ElevatedCaptureWorker {
  /** 子进程的 euid（应当恒为 0，否则说明 sudo 没生效）。 */
  readonly euid: number;
  /** 一问一答（自动配 id / token，自动按 op 定超时）。 */
  request<T>(req: Omit<CaptureWorkerRequest, 'id' | 'token'>, timeoutMs?: number): Promise<T>;
  /** 杀掉子进程并关连接（幂等）。 */
  dispose(): void;
}

/**
 * `sudo -n true`：非交互探测 sudo 凭据是否还在缓存里。`-n` 保证它**绝不弹提示、绝不
 * 等输入** —— 没缓存就立刻非零退出。
 */
function sudoCredentialsCached(): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(resolveSudoPath(), ['-n', 'true'], { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** 起子进程、等 hello、连上环回端口。失败时用 stderr 解释原因。 */
function spawnAndConnect(
  ntHelperPath: string,
  password: string,
): Promise<{ child: ChildProcess; hello: CaptureWorkerHello }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveSudoPath(),
      [
        '-S',
        '/usr/bin/env',
        'ELECTRON_RUN_AS_NODE=1',
        process.execPath,
        resolveWorkerPath(),
        ntHelperPath,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL');
        reject(new Error('提权抓包子进程超时未就绪（sudo 认证或 native 加载失败）'));
      });
    }, HELLO_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const index = stdout.indexOf('\n');
      if (index < 0) return;
      const line = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      let hello: CaptureWorkerHello | null = null;
      try {
        const parsed = JSON.parse(line) as CaptureWorkerHello;
        if (parsed && typeof parsed.port === 'number' && typeof parsed.token === 'string') {
          hello = parsed;
        }
      } catch {
        /* 不是 JSON：忽略 */
      }
      if (!hello) return;
      finish(() => {
        if (hello!.euid !== 0) {
          child.kill('SIGKILL');
          reject(new Error('提权未生效（子进程 euid 不是 0），无法抓包'));
          return;
        }
        resolve({ child, hello: hello! });
      });
    });
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (e) => {
      finish(() => reject(new Error(`sudo 无法启动（是否已安装 sudo？）：${e.message}`)));
    });
    child.on('close', (code) => {
      finish(() =>
        reject(
          new Error(
            `提权抓包子进程退出（code ${code}）：${linuxSudoErrorHint(stderr.trim() || '无输出')}`,
          ),
        ),
      );
    });

    child.stdin?.on('error', () => {
      // sudo 提前退出（密码错）——忽略 EPIPE。
    });
    child.stdin?.write(`${password}\n`);
    child.stdin?.end();
  });
}

/** 环回连接：按行 JSON、id 对账、逐条超时。 */
function connectWorker(
  socket: Socket,
  token: string,
): Omit<ElevatedCaptureWorker, 'euid' | 'dispose'> {
  let nextId = 1;
  let buffer = '';
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  socket.setNoDelay(true);
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const reply = JSON.parse(line) as CaptureWorkerReply;
        const entry = pending.get(reply.id);
        if (entry) {
          pending.delete(reply.id);
          clearTimeout(entry.timer);
          if (reply.ok) entry.resolve(reply.result);
          else entry.reject(new Error(reply.error));
        }
      } catch {
        /* 不是 JSON：忽略 */
      }
      index = buffer.indexOf('\n');
    }
  });
  const failAll = (error: Error): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  socket.on('error', (e) => failAll(new Error(`提权抓包连接出错：${e.message}`)));
  socket.on('close', () => failAll(new Error('提权抓包连接已断开')));

  return {
    request<T>(req: Omit<CaptureWorkerRequest, 'id' | 'token'>, timeoutMs?: number): Promise<T> {
      const id = nextId++;
      const waitMs = req.op === 'take' ? (req.waitMs ?? 0) : 0;
      const budget = timeoutMs ?? waitMs + REQUEST_TIMEOUT_MS;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`提权抓包请求超时（${req.op}）`));
        }, budget);
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
          timer,
        });
        // 首帧带口令自证身份，之后不再重复。
        const payload: CaptureWorkerRequest = id === 1 ? { ...req, id, token } : { ...req, id };
        socket.write(`${JSON.stringify(payload)}\n`);
      });
    },
  };
}

/**
 * 起一个提权抓包子进程并返回可用的连接。需要时先弹密码框（凭据已缓存则不弹）。
 * 用户取消授权 / sudo 失败时抛错，调用方原样抛给前端。
 */
export async function startElevatedCaptureWorker(
  ntHelperPath: string,
): Promise<ElevatedCaptureWorker> {
  let password = '';
  if (!(await sudoCredentialsCached())) {
    const entered = await requestSudoPassword(
      '提权抓包',
      '抓包要打开网卡原始套接字（需要管理员权限），而 WeQ 不能以管理员身份运行 —— ' +
        '请授权一个临时的管理员子进程来完成抓包。请输入你的管理员密码。',
    );
    if (!entered) throw new Error('已取消授权，未开始抓包。');
    password = entered;
  }

  const { child, hello } = await spawnAndConnect(ntHelperPath, password);
  logger.info('elevated capture worker ready', {
    event: 'capture-worker-ready',
    euid: hello.euid,
    backend: hello.backend,
    pid: child.pid,
  });

  const socket = await new Promise<Socket>((resolve, reject) => {
    const conn = connect({ port: hello.port, host: '127.0.0.1' });
    conn.once('connect', () => resolve(conn));
    conn.once('error', (e) => reject(new Error(`连接提权抓包子进程失败：${e.message}`)));
  });

  const channel = connectWorker(socket, hello.token);
  let disposed = false;
  return {
    euid: hello.euid,
    request: channel.request,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      logger.info('elevated capture worker disposed', { event: 'capture-worker-disposed' });
    },
  };
}
