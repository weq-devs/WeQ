/**
 * Main-process client for {@link standardDbWorker}.
 *
 * The worker is started lazily on the first plain-SQLite call and kept alive;
 * requests are multiplexed by numeric id. `serialization: 'advanced'` is
 * mandatory because SQL rows carry `bigint` / `Uint8Array`.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChildWorkerPath } from '../worker_path';
import type { StandardDbMethod, StandardDbRequest, StandardDbResponse } from './protocol';

const moduleDir = dirname(fileURLToPath(import.meta.url));

interface PendingRequest {
  worker: ChildProcess;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class StandardDbClient {
  private worker: ChildProcess | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private disposed = false;

  constructor(private readonly addonPath: string) {}

  /** Run one method in the standard lane. Rejects if the worker exits. */
  request<T>(method: StandardDbMethod, args: unknown[]): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('标准 SQLite 子进程已关闭'));
    }

    let worker: ChildProcess;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(error);
    }

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        worker,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      const request: StandardDbRequest = { id, method, args };
      worker.send(request, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  /** Fire-and-forget variant for void bookkeeping (`closeDb`, ...). */
  notify(method: StandardDbMethod, args: unknown[]): void {
    void this.request(method, args).catch(() => {
      /* best-effort: a dead worker is reported by the next real request */
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const worker = this.worker;
    this.worker = undefined;

    if (worker) {
      const request: StandardDbRequest = { id: 0, method: 'closeAllDb', args: [] };
      try {
        worker.send(request, () => {
          try {
            worker.disconnect();
          } catch {
            /* already gone */
          }
        });
      } catch {
        /* channel already closed */
      }
      const timer = setTimeout(() => {
        try {
          worker.kill();
        } catch {
          /* already gone */
        }
      }, 500);
      timer.unref();
    }

    this.rejectAll(new Error('标准 SQLite 子进程已关闭'));
  }

  private ensureWorker(): ChildProcess {
    if (this.worker) return this.worker;

    const workerPath = resolveChildWorkerPath('standardDbWorker.mjs', moduleDir);
    const worker = fork(workerPath, [this.addonPath], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
    });

    worker.on('message', (message: unknown) => this.handleMessage(worker, message));
    worker.on('error', (error) => {
      if (this.worker === worker) this.worker = undefined;
      this.rejectWorker(worker, new Error(`标准 SQLite 子进程错误：${error.message}`));
    });
    worker.on('exit', (code, signal) => {
      if (this.worker === worker) this.worker = undefined;
      this.rejectWorker(
        worker,
        new Error(`标准 SQLite 子进程已退出（${signal ?? code ?? 'unknown'}）`),
      );
    });

    this.worker = worker;
    return worker;
  }

  private handleMessage(worker: ChildProcess, raw: unknown): void {
    const response = raw as StandardDbResponse | null;
    if (!response || typeof response.id !== 'number') return;

    const pending = this.pending.get(response.id);
    if (!pending || pending.worker !== worker) return;
    this.pending.delete(response.id);

    if (response.ok) {
      pending.resolve(response.value);
      return;
    }

    const error = new Error(response.error.message);
    error.name = response.error.name;
    if (response.error.stack) error.stack = response.error.stack;
    pending.reject(error);
  }

  private rejectWorker(worker: ChildProcess, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.worker !== worker) continue;
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
