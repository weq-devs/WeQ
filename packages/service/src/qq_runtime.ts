export const QQ_RUNTIME_MAX_RESTARTS = 3;
export type QQRuntimeMode = 'external' | 'managed';
export type QQRuntimePhase =
  | 'stopped'
  | 'starting'
  | 'connecting'
  | 'awaiting-login'
  | 'scanned'
  | 'initializing-session'
  | 'online'
  | 'recovering'
  | 'failed'
  | 'stopping';
export interface QQRuntimeAccount {
  uin: string;
  uid: string | null;
}
export interface QQRuntimeCapabilities {
  login: boolean;
  sso: boolean;
  database: boolean;
  push: boolean;
}
export interface QQRuntimeObservation {
  phase: QQRuntimePhase;
  account: QQRuntimeAccount | null;
  capabilities: QQRuntimeCapabilities;
  qr: { pngBase64: string; url: string } | null;
  error: string | null;
}
export interface QQRuntimeSnapshot extends QQRuntimeObservation {
  instanceId: string | null;
  mode: QQRuntimeMode | null;
  pid: number | null;
  owned: boolean;
  restarts: number;
}
export type QQRuntimeBackendEvent =
  | { type: 'observation'; value: QQRuntimeObservation }
  | { type: 'exit'; code: number | null; signal: string | null; retryable?: boolean };
export interface ManagedQQRuntimeBackend {
  readonly pid: number;
  readonly owned: true;
  subscribe(listener: (event: QQRuntimeBackendEvent) => void): () => void;
  initialize(signal: AbortSignal): Promise<void>;
  login(uin?: string): Promise<void>;
  refreshQr(): Promise<void>;
  health(): Promise<void>;
  close(): Promise<void>;
}
export interface QQRuntimeDependencies {
  createManaged(input: {
    instanceId: string;
    expectedUin?: string;
    signal: AbortSignal;
  }): Promise<ManagedQQRuntimeBackend>;
  inspectExternal(
    uin: string,
    signal: AbortSignal,
  ): Promise<({ pid: number } & QQRuntimeObservation) | null>;
  createId(): string;
  onObserverError?(error: unknown): void;
}

const noCapabilities = (): QQRuntimeCapabilities => ({
  login: false,
  sso: false,
  database: false,
  push: false,
});
const empty = (): QQRuntimeSnapshot => ({
  instanceId: null,
  mode: null,
  pid: null,
  owned: false,
  phase: 'stopped',
  account: null,
  capabilities: noCapabilities(),
  qr: null,
  error: null,
  restarts: 0,
});

/** 实例、账号、能力分别建模。原生凭据不进入公开快照。 */
export class QQRuntimeManager {
  private value = empty();
  private listeners = new Set<(state: QQRuntimeSnapshot) => void>();
  private driver: ManagedQQRuntimeBackend | null = null;
  private unsubscribe: (() => void) | null = null;
  private abort: AbortController | null = null;
  private generation = 0;
  private transitions: Promise<void> = Promise.resolve();
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private expectedUin: string | undefined;
  private restartCount = 0;
  private healthySince = 0;

  constructor(private readonly deps: QQRuntimeDependencies) {}
  snapshot(): QQRuntimeSnapshot {
    return {
      ...this.value,
      account: this.value.account ? { ...this.value.account } : null,
      capabilities: { ...this.value.capabilities },
      qr: this.value.qr ? { ...this.value.qr } : null,
    };
  }
  subscribe(listener: (state: QQRuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(patch: Partial<QQRuntimeSnapshot>): void {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot());
      } catch (error) {
        this.deps.onObserverError?.(error);
      }
    }
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.transitions.then(task);
    this.transitions = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  private cancel(): number {
    this.abort?.abort();
    this.abort = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    return ++this.generation;
  }
  private async release(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const driver = this.driver;
    if (driver?.owned) await driver.close();
    if (this.driver === driver) this.driver = null;
  }
  private fail(generation: number, error: unknown): void {
    if (generation !== this.generation) return;
    this.publish({
      phase: 'failed',
      error: error instanceof Error ? error.message : String(error),
      capabilities: noCapabilities(),
      qr: null,
      pid: this.driver?.pid ?? null,
      owned: this.driver?.owned === true,
    });
  }

  startManaged(expectedUin?: string): Promise<QQRuntimeSnapshot> {
    if (expectedUin !== undefined && !/^[1-9]\d*$/.test(expectedUin))
      return Promise.reject(new Error('QQ 账号无效'));
    this.restartCount = 0;
    this.healthySince = 0;
    this.expectedUin = expectedUin;
    return this.startManagedTurn();
  }
  private startManagedTurn(): Promise<QQRuntimeSnapshot> {
    const generation = this.cancel();
    const controller = new AbortController();
    this.abort = controller;
    this.publish({
      phase: 'starting',
      mode: 'managed',
      qr: null,
      account: null,
      capabilities: noCapabilities(),
      error: null,
      restarts: this.restartCount,
    });
    return this.serial(async () => {
      try {
        await this.release();
      } catch (error) {
        this.fail(generation, error);
        return this.snapshot();
      }
      if (generation !== this.generation) return this.snapshot();
      const instanceId = this.deps.createId();
      this.publish({ instanceId, pid: null, owned: false });
      let driver: ManagedQQRuntimeBackend | null = null;
      try {
        driver = await this.deps.createManaged({
          instanceId,
          ...(this.expectedUin ? { expectedUin: this.expectedUin } : {}),
          signal: controller.signal,
        });
        if (generation !== this.generation) {
          if (driver.owned) await driver.close();
          return this.snapshot();
        }
        if (!driver.owned || !Number.isSafeInteger(driver.pid) || driver.pid <= 0)
          throw new Error('托管后端没有有效的真实进程');
        this.driver = driver;
        this.publish({ pid: driver.pid, owned: true });
        this.unsubscribe = driver.subscribe((event) => {
          if (generation !== this.generation) return;
          if (event.type === 'exit') this.onExit(generation, event);
          else this.observe(generation, event.value);
        });
        await driver.initialize(controller.signal);
        if (generation === this.generation) await driver.login(this.expectedUin);
      } catch (error) {
        if (generation === this.generation) {
          try {
            await this.release();
          } catch (cleanupError) {
            this.fail(generation, cleanupError);
            return this.snapshot();
          }
          this.fail(generation, error);
        } else if (driver?.owned && driver !== this.driver) await driver.close();
      }
      return this.snapshot();
    });
  }

  connectExternal(uin: string): Promise<QQRuntimeSnapshot> {
    if (!/^[1-9]\d*$/.test(uin)) return Promise.reject(new Error('QQ 账号无效'));
    this.expectedUin = uin;
    this.restartCount = 0;
    this.healthySince = 0;
    const generation = this.cancel(),
      controller = new AbortController();
    this.abort = controller;
    this.publish({
      phase: 'starting',
      mode: 'external',
      qr: null,
      account: null,
      capabilities: noCapabilities(),
      error: null,
      restarts: 0,
    });
    return this.serial(async () => {
      try {
        await this.release();
      } catch (error) {
        this.fail(generation, error);
        return this.snapshot();
      }
      if (generation !== this.generation) return this.snapshot();
      let observed: Awaited<ReturnType<QQRuntimeDependencies['inspectExternal']>>;
      try {
        observed = await this.deps.inspectExternal(uin, controller.signal);
      } catch (error) {
        if (generation === this.generation)
          this.publish({
            phase: 'failed',
            error: error instanceof Error ? error.message : String(error),
            pid: null,
            owned: false,
          });
        return this.snapshot();
      }
      if (generation !== this.generation) return this.snapshot();
      if (!observed) {
        this.publish({ ...empty(), mode: 'external', phase: 'awaiting-login' });
        return this.snapshot();
      }
      if (
        !Number.isSafeInteger(observed.pid) ||
        observed.pid <= 0 ||
        observed.account?.uin !== uin
      ) {
        this.publish({
          phase: 'failed',
          error: '外部 QQ 账号或进程不匹配',
          pid: null,
          owned: false,
        });
        return this.snapshot();
      }
      this.publish({
        instanceId: this.deps.createId(),
        mode: 'external',
        pid: observed.pid,
        owned: false,
      });
      this.observe(generation, observed);
      return this.snapshot();
    });
  }

  private observe(generation: number, observed: QQRuntimeObservation): void {
    if (generation !== this.generation) return;
    const account = observed.account;
    if (
      account &&
      (!/^[1-9]\d*$/.test(account.uin) ||
        (account.uid !== null && !/^u_[A-Za-z0-9_-]+$/.test(account.uid)) ||
        (this.expectedUin && account.uin !== this.expectedUin))
    ) {
      this.rejectAccount('运行时账号与选定账号不匹配');
      return;
    }
    if (
      this.value.account &&
      account &&
      (this.value.account.uin !== account.uin ||
        (this.value.account.uid && account.uid && this.value.account.uid !== account.uid))
    ) {
      this.rejectAccount('运行中账号身份发生变化');
      return;
    }
    const capabilities = {
      login: observed.capabilities.login === true,
      sso: Boolean(account?.uid && observed.capabilities.sso === true),
      database: Boolean(account && observed.capabilities.database === true),
      push: Boolean(account && observed.capabilities.push === true),
    };
    const phase =
      observed.phase === 'online' && (!account || !capabilities.sso || !capabilities.database)
        ? 'initializing-session'
        : observed.phase;
    if (phase === 'online' && !this.healthySince) this.healthySince = Date.now();
    if (phase !== 'online') this.healthySince = 0;
    this.publish({
      phase,
      account: account ? { uin: account.uin, uid: account.uid } : null,
      capabilities,
      qr: observed.qr ? { pngBase64: observed.qr.pngBase64, url: observed.qr.url } : null,
      error: observed.error,
    });
  }

  private rejectAccount(message: string): void {
    const generation = this.cancel();
    this.publish({ phase: 'stopping', qr: null, capabilities: noCapabilities() });
    void this.serial(async () => {
      await this.release();
      if (generation === this.generation)
        this.publish({ ...empty(), phase: 'failed', error: message });
    }).catch(() => {
      if (generation === this.generation)
        this.publish({ phase: 'failed', error: `${message}；托管清理失败` });
    });
  }

  private onExit(
    generation: number,
    event: Extract<QQRuntimeBackendEvent, { type: 'exit' }>,
  ): void {
    if (generation !== this.generation) return;
    if (this.value.account) this.expectedUin ??= this.value.account.uin;
    if (this.healthySince && Date.now() - this.healthySince > 60_000) this.restartCount = 0;
    this.healthySince = 0;
    this.publish({
      phase: 'recovering',
      pid: null,
      owned: false,
      capabilities: noCapabilities(),
      qr: null,
      error: `QQ 托管进程已退出 (${event.signal ?? event.code ?? 'unknown'})`,
    });
    if (event.retryable === false) {
      this.publish({ phase: 'failed' });
      return;
    }
    if (this.restartCount >= QQ_RUNTIME_MAX_RESTARTS) {
      this.publish({ phase: 'failed' });
      return;
    }
    const delay = 1000 * 2 ** this.restartCount++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (generation === this.generation) void this.startManagedTurn();
    }, delay);
    this.restartTimer.unref?.();
  }

  async refreshQr(): Promise<void> {
    if (!this.driver || !this.value.owned) throw new Error('当前不是托管登录实例');
    await this.driver.refreshQr();
  }
  async resume(): Promise<void> {
    const driver = this.driver,
      generation = this.generation;
    if (driver && this.value.owned) {
      try {
        await driver.health();
      } catch (error) {
        if (generation === this.generation && driver === this.driver)
          this.publish({
            phase: 'recovering',
            capabilities: noCapabilities(),
            error: error instanceof Error ? error.message : String(error),
          });
        throw error;
      }
    }
  }
  stop(): Promise<QQRuntimeSnapshot> {
    const generation = this.cancel();
    this.publish({ phase: 'stopping', capabilities: noCapabilities(), qr: null });
    return this.serial(async () => {
      try {
        await this.release();
      } catch (error) {
        this.fail(generation, error);
        throw error;
      }
      if (generation === this.generation) this.publish(empty());
      return this.snapshot();
    });
  }
}
