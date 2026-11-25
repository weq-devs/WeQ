import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { resolveNtHelperPath, type DatabaseProgress } from '@weq/native';
import type { DbRepairTarget } from '@weq/service';
import { resolveChildWorkerPath } from './worker_path';

type LockReply = {
  requestId: number;
  error?: string;
  databases?: Array<{ dbPath: string; error?: string }>;
  progress?: DatabaseProgress;
};

/** 持锁进程与扫描、重建进程分离；只有它确认退出后才撤销主进程的写入拦截。 */
export class DatabaseMaintenanceLock {
  readonly signal: AbortSignal;
  readonly pid: number | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lost = new AbortController();
  private readonly closed: Promise<void>;
  private ending = false;
  private exited = false;
  private sequence = 0;
  private readonly requests = new Map<
    number,
    {
      resolve(value: LockReply): void;
      reject(error: Error): void;
      onProgress?: (tick: DatabaseProgress) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(options: { workerPath?: string; executable?: string; nativeRoot?: string } = {}) {
    const worker =
      options.workerPath ??
      resolveChildWorkerPath(
        'dbMaintenanceLockWorker.mjs',
        dirname(fileURLToPath(import.meta.url)),
      );
    this.child = spawn(options.executable ?? process.execPath, [worker], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        WEQ_DATABASE_LOCK_KEEPER: '1',
        WEQ_NATIVE_DIR: options.nativeRoot ?? dirname(dirname(dirname(resolveNtHelperPath()))),
      },
    });
    this.pid = this.child.pid;
    this.signal = this.lost.signal;
    this.closed = new Promise((done) => {
      this.child.once('close', () => {
        this.exited = true;
        const error = new Error('持续维护锁进程已退出，本次体检结果不能继续用于修复。');
        for (const request of this.requests.values()) {
          clearTimeout(request.timer);
          request.reject(error);
        }
        this.requests.clear();
        if (!this.ending) this.lost.abort(error);
        done();
      });
    });
    this.child.on('error', (error) => {
      for (const request of this.requests.values()) request.reject(error);
    });
    this.child.stdin.on('error', () => {});
    const decoder = new StringDecoder('utf8');
    let pending = '';
    this.child.stdout.on('data', (bytes: Buffer) => {
      pending += decoder.write(bytes);
      if (Buffer.byteLength(pending) > 1024 * 1024) {
        void this.terminate();
        return;
      }
      for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const reply = JSON.parse(line) as LockReply;
          const request = this.requests.get(reply.requestId);
          if (!request) continue;
          if (reply.progress) {
            request.onProgress?.(reply.progress);
            continue;
          }
          this.requests.delete(reply.requestId);
          clearTimeout(request.timer);
          if (reply.error) request.reject(new Error(reply.error));
          else request.resolve(reply);
        } catch {
          void this.terminate();
          return;
        }
      }
    });
    // 消费 stderr，既不让原生日志填满管道，也不把账号密钥或请求体转入应用日志。
    this.child.stderr.resume();
  }

  async begin(
    id: string,
    targets: DbRepairTarget[],
    signal: AbortSignal,
    onProgress?: (tick: DatabaseProgress) => void,
  ) {
    const abort = () => {
      void this.terminate();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const reply = await this.request({ kind: 'begin', id, targets }, 5 * 60_000, onProgress);
      signal.throwIfAborted();
      if (
        !reply.databases ||
        reply.databases.length !== targets.length ||
        targets.some((target) => !reply.databases!.some((row) => row.dbPath === target.dbPath))
      )
        throw new Error('持续维护锁进程未确认全部目标数据库。');
      return reply.databases;
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  async protect(dbPath: string, product: string): Promise<void> {
    await this.request({ kind: 'protect', dbPath, product }, 5000);
  }
  async end(): Promise<void> {
    if (this.exited) return;
    this.ending = true;
    try {
      await this.request({ kind: 'end' }, 2000);
    } catch {
      await this.terminate();
    }
    this.child.stdin.end();
    const timer = setTimeout(() => {
      void this.terminate();
    }, 2000);
    try {
      await this.closed;
    } finally {
      clearTimeout(timer);
    }
  }
  async terminate(): Promise<void> {
    if (this.exited) return;
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    try {
      await this.closed;
    } finally {
      clearTimeout(timer);
    }
  }
  private request(
    value: object,
    timeoutMs = 30_000,
    onProgress?: (tick: DatabaseProgress) => void,
  ): Promise<LockReply> {
    if (this.exited || this.signal.aborted)
      return Promise.reject(new Error('持续维护锁已经释放。'));
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        reject(new Error('持续维护锁进程未响应。'));
        void this.terminate();
      }, timeoutMs);
      this.requests.set(requestId, { resolve, reject, timer, onProgress });
      this.child.stdin.write(`${JSON.stringify({ ...value, requestId })}\n`);
    });
  }
}
