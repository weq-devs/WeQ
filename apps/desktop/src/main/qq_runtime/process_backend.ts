import { fork, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import type {
  ManagedQQRuntimeBackend,
  QQRuntimeBackendEvent,
  QQRuntimeObservation,
} from '@weq/service';
import type { QQKernelCommand, QQKernelEvent, QQKernelOptions } from './kernel_protocol';

type Waiter = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };

export async function createQQKernelProcessBackend(
  options: QQKernelOptions,
  workerPath: string,
  execPath = process.execPath,
  signal?: AbortSignal,
): Promise<QQKernelProcessBackend> {
  if (signal?.aborted) throw new Error('托管启动已取消');
  await mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
  if (signal?.aborted) throw new Error('托管启动已取消');
  const backend = new QQKernelProcessBackend(options, workerPath, execPath);
  if (backend.pid <= 0) {
    await backend.close();
    throw new Error('QQ 托管进程未创建');
  }
  return backend;
}
function waiter(): Waiter {
  let resolve = () => {},
    reject = (_error: Error) => {};
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/** 只持有自己 fork 的进程句柄，绝不按名字终止 QQ 或其他 Electron。 */
export class QQKernelProcessBackend implements ManagedQQRuntimeBackend {
  readonly owned = true;
  readonly pid: number;
  private readonly child: ChildProcess;
  private readonly boot = waiter();
  private readonly exit = waiter();
  private healthWait: Waiter | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(event: QQRuntimeBackendEvent) => void>();
  private closed: Promise<void> | null = null;
  private exited = false;
  private initialized = false;
  private bootSent = false;
  private fatal = false;
  private state: QQRuntimeObservation = {
    phase: 'starting',
    account: null,
    qr: null,
    error: null,
    capabilities: { login: false, sso: false, database: false, push: false },
  };

  constructor(
    private readonly options: QQKernelOptions,
    workerPath: string,
    execPath = process.execPath,
  ) {
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.NODE_OPTIONS;
    delete env.DYLD_INSERT_LIBRARIES;
    this.child = fork(workerPath, [], {
      execPath,
      env,
      cwd: options.dataRoot,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.pid = this.child.pid ?? -1;
    this.child.on('message', (event: unknown) => this.receive(event));
    this.child.once('error', () => {
      this.fatal = true;
      this.boot.reject(new Error('无法启动 QQ 托管 Worker'));
    });
    const finish = (code: number | null, signal: string | null) => {
      if (this.exited) return;
      this.exited = true;
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupTimer = null;
      this.boot.reject(new Error('QQ 托管 Worker 在就绪前退出'));
      this.healthWait?.reject(new Error('QQ 托管 Worker 已退出'));
      this.healthWait = null;
      this.exit.resolve();
      for (const listener of this.listeners)
        listener({ type: 'exit', code, signal, retryable: !this.fatal });
    };
    this.child.once('exit', finish);
    this.child.once('close', finish);
  }

  subscribe(listener: (event: QQRuntimeBackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(patch: Partial<QQRuntimeObservation>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners)
      listener({
        type: 'observation',
        value: { ...this.state, capabilities: { ...this.state.capabilities } },
      });
  }
  private receive(value: unknown): void {
    if (!value || typeof value !== 'object' || this.exited) return;
    const raw = value as Record<string, unknown>;
    if (
      raw.instanceId !== this.options.instanceId ||
      raw.pid !== this.pid ||
      typeof raw.type !== 'string'
    )
      return;
    const event = raw as unknown as QQKernelEvent;
    switch (event.type) {
      case 'initialized':
        this.initialized = true;
        this.boot.resolve();
        this.publish({
          phase: 'awaiting-login',
          capabilities: { ...this.state.capabilities, login: true },
        });
        break;
      case 'connecting':
        this.publish({ phase: 'connecting', qr: null });
        break;
      case 'connected':
        this.publish({ phase: this.state.account ? 'initializing-session' : 'awaiting-login' });
        break;
      case 'disconnected':
        this.publish({
          phase: 'recovering',
          qr: null,
          capabilities: { ...this.state.capabilities, sso: false, push: false },
        });
        break;
      case 'qr':
        if (
          typeof event.pngBase64 !== 'string' ||
          event.pngBase64.length > 2 * 1024 * 1024 ||
          typeof event.url !== 'string' ||
          event.url.length > 4096
        )
          return;
        this.publish({
          phase: 'awaiting-login',
          qr: { pngBase64: event.pngBase64, url: event.url },
          error: null,
        });
        break;
      case 'scanned':
        this.publish({ phase: 'scanned' });
        break;
      case 'qr-expired':
        this.publish({ phase: 'awaiting-login', qr: null, error: '二维码已过期，请重新获取' });
        break;
      case 'login':
        if (typeof event.uin !== 'string' || typeof event.uid !== 'string') return;
        this.publish({
          phase: 'initializing-session',
          account: { uin: event.uin, uid: event.uid },
          qr: null,
        });
        break;
      case 'session-initialized':
        // 内核会话初始化不等于凭据和数据库已验证，能力仍由后续真实接入发布。
        this.publish({ phase: 'initializing-session' });
        break;
      case 'health':
        this.healthWait?.resolve();
        this.healthWait = null;
        if (!event.connected)
          this.publish({
            phase: 'recovering',
            capabilities: { ...this.state.capabilities, sso: false, push: false },
          });
        break;
      case 'error':
        if (typeof event.message !== 'string') return;
        if (!this.initialized || event.code === 'account-mismatch') this.fatal = true;
        this.boot.reject(new Error(event.message.slice(0, 1024)));
        this.publish({
          phase: 'failed',
          error: event.message.slice(0, 1024),
          capabilities: { ...this.state.capabilities, sso: false, push: false },
          qr: null,
        });
        break;
      case 'verification':
        this.publish({ phase: 'awaiting-login', qr: null, error: '需要完成 QQ 官方验证' });
        break;
      case 'stopped':
        if (!this.closed) void this.close();
        break;
    }
  }

  private send(command: QQKernelCommand): Promise<void> {
    if (this.exited || !this.child.connected)
      return Promise.reject(new Error('QQ 托管 Worker 已断开'));
    return new Promise((resolve, reject) => {
      this.child.send(command, (error) =>
        error ? reject(new Error('无法发送托管命令')) : resolve(),
      );
    });
  }
  async initialize(signal: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(this.pid) || this.pid <= 0) throw new Error('QQ 托管进程未创建');
    const cancel = () => {
      this.boot.reject(new Error('托管启动已取消'));
      void this.close();
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) {
        cancel();
        throw new Error('托管启动已取消');
      }
      this.startupTimer = setTimeout(() => {
        this.fatal = true;
        this.boot.reject(new Error('QQ 内核初始化超时'));
        void this.close();
      }, 15_000);
      this.startupTimer.unref?.();
      this.bootSent = true;
      await this.send({ type: 'boot', options: this.options });
      await this.boot.promise;
    } finally {
      signal.removeEventListener('abort', cancel);
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }
  login(uin?: string): Promise<void> {
    return this.send({
      type: 'login',
      instanceId: this.options.instanceId,
      nonce: this.options.nonce,
      ...(uin ? { uin } : {}),
    });
  }
  refreshQr(): Promise<void> {
    return this.send({
      type: 'refresh-qr',
      instanceId: this.options.instanceId,
      nonce: this.options.nonce,
    });
  }
  async health(): Promise<void> {
    if (this.healthWait) return this.healthWait.promise;
    const pending = waiter();
    this.healthWait = pending;
    const timer = setTimeout(() => {
      pending.reject(new Error('QQ 托管 Worker 无响应'));
      void this.close();
    }, 5000);
    timer.unref?.();
    try {
      await this.send({
        type: 'health',
        instanceId: this.options.instanceId,
        nonce: this.options.nonce,
      });
      await pending.promise;
    } finally {
      clearTimeout(timer);
      if (this.healthWait === pending) this.healthWait = null;
    }
  }
  close(): Promise<void> {
    this.closed ??= (async () => {
      if (this.exited) return;
      const term = setTimeout(() => this.child.kill('SIGTERM'), 5000);
      const kill = setTimeout(() => this.child.kill('SIGKILL'), 7000);
      term.unref?.();
      kill.unref?.();
      try {
        if (!this.bootSent && this.child.connected) this.child.disconnect();
        else
          await this.send({
            type: 'stop',
            instanceId: this.options.instanceId,
            nonce: this.options.nonce,
          }).catch(() => {});
        await this.exit.promise;
      } finally {
        clearTimeout(term);
        clearTimeout(kill);
      }
    })();
    return this.closed;
  }
}
