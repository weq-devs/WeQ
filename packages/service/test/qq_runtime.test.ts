import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QQRuntimeManager,
  QQ_RUNTIME_MAX_RESTARTS,
  type ManagedQQRuntimeBackend,
  type QQRuntimeBackendEvent,
  type QQRuntimeObservation,
  type QQRuntimeDependencies,
} from '../src/qq_runtime';

const observed = (patch: Partial<QQRuntimeObservation> = {}): QQRuntimeObservation => ({
  phase: 'awaiting-login',
  account: null,
  capabilities: { login: true, sso: false, database: false, push: false },
  qr: null,
  error: null,
  ...patch,
});
class Backend implements ManagedQQRuntimeBackend {
  readonly owned = true;
  listeners = new Set<(event: QQRuntimeBackendEvent) => void>();
  constructor(readonly pid: number) {}
  emit(event: QQRuntimeBackendEvent) {
    for (const listener of this.listeners) listener(event);
  }
  subscribe(listener: (event: QQRuntimeBackendEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  initialize = vi.fn(async (_signal: AbortSignal) => {
    this.emit({ type: 'observation', value: observed() });
  });
  login = vi.fn(async (_uin?: string) => {});
  refreshQr = vi.fn(async () => {});
  health = vi.fn(async () => {});
  close = vi.fn(async () => {});
}
function fixture() {
  const backends: Backend[] = [];
  const deps: QQRuntimeDependencies = {
    createManaged: async () => {
      const backend = new Backend(100 + backends.length);
      backends.push(backend);
      return backend;
    },
    inspectExternal: async () => null,
    createId: () => `instance-${backends.length}`,
    onObserverError: vi.fn(),
  };
  return { deps, backends, manager: new QQRuntimeManager(deps) };
}
afterEach(() => vi.useRealTimers());

describe('QQ 运行时生命周期', () => {
  it('唤醒时只刷新外部 QQ 观察，不接管或启动进程', async () => {
    const f = fixture(),
      inspect = vi.fn(async () => null);
    f.deps.inspectExternal = inspect;
    await f.manager.connectExternal('10001');
    await f.manager.resume();
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(f.backends).toHaveLength(0);
    await f.manager.stop();
  });
  it('切到外部模式前清理失败仍准确保留托管句柄，不冒充外部就绪', async () => {
    const f = fixture();
    await f.manager.startManaged('10001');
    f.backends[0]!.close.mockRejectedValueOnce(new Error('fixture-close'));
    const inspect = vi.fn(async () => null);
    f.deps.inspectExternal = inspect;
    expect(await f.manager.connectExternal('10002')).toMatchObject({
      phase: 'failed',
      mode: 'managed',
      pid: 100,
      owned: true,
    });
    await f.manager.refreshExternal();
    expect(inspect).not.toHaveBeenCalled();
    await f.manager.stop();
  });
  it('无效 PID 后端清理失败仍保留可重试句柄，但不向界面发布该 PID', async () => {
    const f = fixture(),
      invalid = new Backend(0);
    invalid.close.mockRejectedValueOnce(new Error('fixture-cleanup'));
    f.deps.createManaged = async () => invalid;
    expect(await f.manager.startManaged()).toMatchObject({
      phase: 'failed',
      pid: null,
      owned: true,
    });
    await f.manager.stop();
    expect(invalid.close).toHaveBeenCalledTimes(2);
    expect(f.manager.snapshot()).toMatchObject({ phase: 'stopped', pid: null, owned: false });
  });
  it('后端返回无效 PID 时仍清理已创建的自有句柄，不发布虚构进程', async () => {
    const f = fixture(),
      invalid = new Backend(0);
    f.deps.createManaged = async () => invalid;
    expect(await f.manager.startManaged()).toMatchObject({
      phase: 'failed',
      pid: null,
      owned: false,
    });
    expect(invalid.close).toHaveBeenCalledOnce();
    expect(invalid.initialize).not.toHaveBeenCalled();
  });
  it('外部 QQ 能力可刷新，同一实例保持 ID，失联时清空旧能力', async () => {
    const f = fixture();
    let sequence = 0;
    f.deps.createId = () => `external-${++sequence}`;
    f.deps.inspectExternal = async () => ({
      pid: 123,
      ...observed({
        phase: 'online',
        account: { uin: '10001', uid: 'u_self' },
        capabilities: { login: false, sso: true, database: true, push: false },
      }),
    });
    await f.manager.connectExternal('10001');
    const id = f.manager.snapshot().instanceId;
    await f.manager.refreshExternal();
    expect(f.manager.snapshot()).toMatchObject({ instanceId: id, phase: 'online' });
    f.deps.inspectExternal = async () => {
      throw new Error('fixture-offline');
    };
    await f.manager.refreshExternal();
    expect(f.manager.snapshot()).toMatchObject({
      phase: 'failed',
      pid: null,
      account: null,
      capabilities: { sso: false, database: false },
    });
    await f.manager.stop();
  });
  it('真实进程、账号和能力分别发布；仅登录不能冒充完整在线', async () => {
    const f = fixture();
    await f.manager.startManaged('10001');
    expect(f.manager.snapshot()).toMatchObject({
      pid: 100,
      owned: true,
      account: null,
      phase: 'awaiting-login',
    });
    f.backends[0]!.emit({
      type: 'observation',
      value: observed({ phase: 'online', account: { uin: '10001', uid: 'u_self' } }),
    });
    expect(f.manager.snapshot()).toMatchObject({
      phase: 'initializing-session',
      capabilities: { sso: false, database: false },
    });
    f.backends[0]!.emit({
      type: 'observation',
      value: observed({
        phase: 'online',
        account: { uin: '10001', uid: 'u_self' },
        capabilities: { login: true, sso: true, database: true, push: true },
      }),
    });
    expect(f.manager.snapshot().phase).toBe('online');
    await f.manager.stop();
  });

  it('停止托管会清理自己的后端和二维码，但不会结束外部 QQ', async () => {
    const f = fixture();
    await f.manager.startManaged();
    f.backends[0]!.emit({
      type: 'observation',
      value: observed({ qr: { pngBase64: 'fixture', url: 'fixture' } }),
    });
    await f.manager.stop();
    expect(f.backends[0]!.close).toHaveBeenCalledOnce();
    expect(f.manager.snapshot()).toMatchObject({
      phase: 'stopped',
      pid: null,
      owned: false,
      qr: null,
    });
    f.deps.inspectExternal = async () => ({
      pid: 200,
      ...observed({ account: { uin: '10002', uid: 'u_external' } }),
    });
    await f.manager.connectExternal('10002');
    expect(f.manager.snapshot()).toMatchObject({ mode: 'external', owned: false, pid: 200 });
    await f.manager.stop();
    expect(f.backends[0]!.close).toHaveBeenCalledOnce();
  });

  it('启动途中停止，迟到创建的后端也被清理且不会再登录', async () => {
    const f = fixture();
    let finish: (backend: ManagedQQRuntimeBackend) => void = () => {};
    f.deps.createManaged = async () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const starting = f.manager.startManaged();
    await vi.waitFor(() => expect(f.manager.snapshot().instanceId).not.toBeNull());
    const stopping = f.manager.stop();
    const late = new Backend(123);
    finish(late);
    await starting;
    await stopping;
    expect(late.close).toHaveBeenCalledOnce();
    expect(late.initialize).not.toHaveBeenCalled();
    expect(late.login).not.toHaveBeenCalled();
    expect(f.manager.snapshot().phase).toBe('stopped');
  });

  it('旧实例和错误账号的事件不能污染新实例', async () => {
    const f = fixture();
    await f.manager.startManaged('10001');
    const old = [...f.backends[0]!.listeners][0]!;
    await f.manager.startManaged('10002');
    old({ type: 'observation', value: observed({ account: { uin: '10001', uid: 'u_old' } }) });
    expect(f.manager.snapshot().account).toBeNull();
    f.backends[1]!.emit({
      type: 'observation',
      value: observed({ account: { uin: '10003', uid: 'u_wrong' } }),
    });
    await vi.waitFor(() => expect(f.manager.snapshot().phase).toBe('failed'));
    expect(f.backends[1]!.close).toHaveBeenCalledOnce();
    expect(f.manager.snapshot().error).toContain('不匹配');
  });

  it('异常退出有界重启，手动停止取消定时器', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const f = fixture();
    await f.manager.startManaged();
    for (let i = 0; i <= QQ_RUNTIME_MAX_RESTARTS; i++) {
      f.backends.at(-1)!.emit({ type: 'exit', code: null, signal: 'SIGSEGV' });
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(f.backends).toHaveLength(QQ_RUNTIME_MAX_RESTARTS + 1);
    expect(f.manager.snapshot().phase).toBe('failed');
    await f.manager.startManaged();
    f.backends.at(-1)!.emit({ type: 'exit', code: 1, signal: null });
    const count = f.backends.length;
    await f.manager.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.backends).toHaveLength(count);
  });

  it('持续健康超过恢复窗口后重新获得重启预算', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const f = fixture();
    await f.manager.startManaged();
    f.backends[0]!.emit({ type: 'exit', code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(1000);
    f.backends[1]!.emit({
      type: 'observation',
      value: observed({
        phase: 'online',
        account: { uin: '10001', uid: 'u_self' },
        capabilities: { login: true, sso: true, database: true, push: true },
      }),
    });
    await vi.advanceTimersByTimeAsync(60_001);
    f.backends[1]!.emit({ type: 'exit', code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.manager.snapshot().restarts).toBe(1);
    expect(f.backends).toHaveLength(3);
    await f.manager.stop();
  });

  it('后端附带的原生凭据不进入运行时快照', async () => {
    const f = fixture();
    await f.manager.startManaged();
    f.backends[0]!.emit({
      type: 'observation',
      value: observed({
        account: Object.assign(
          { uin: '10001', uid: 'u_self' },
          { a2: 'secret-a2', dbKey: 'secret-db' },
        ),
        capabilities: Object.assign(
          { login: true, sso: false, database: false, push: false },
          { d2Key: 'secret-d2' },
        ),
      }),
    });
    expect(JSON.stringify(f.manager.snapshot())).not.toContain('secret-');
    await f.manager.stop();
  });

  it('明确不可重试的启动失败不产生循环重启', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.manager.startManaged();
    f.backends[0]!.emit({ type: 'exit', code: 1, signal: null, retryable: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.backends).toHaveLength(1);
    expect(f.manager.snapshot().phase).toBe('failed');
    await f.manager.stop();
  });

  it('坏订阅者不会中断其他订阅者或运行时，快照修改不写回内部', async () => {
    const f = fixture();
    f.manager.subscribe(() => {
      throw new Error('observer');
    });
    const listener = vi.fn();
    f.manager.subscribe(listener);
    await f.manager.startManaged();
    expect(listener).toHaveBeenCalled();
    expect(f.deps.onObserverError).toHaveBeenCalled();
    const snapshot = f.manager.snapshot();
    snapshot.capabilities.sso = true;
    expect(f.manager.snapshot().capabilities.sso).toBe(false);
    await f.manager.stop();
  });

  it('外部探测失败及无效 PID 均不发布可用会话', async () => {
    const f = fixture();
    f.deps.inspectExternal = async () => {
      throw new Error('probe');
    };
    expect((await f.manager.connectExternal('10001')).phase).toBe('failed');
    f.deps.inspectExternal = async () => ({
      pid: 0,
      ...observed({ account: { uin: '10001', uid: 'u_self' } }),
    });
    expect((await f.manager.connectExternal('10001')).pid).toBeNull();
    await f.manager.stop();
  });

  it('旧实例的迟到健康检查失败不会覆盖新账号', async () => {
    const f = fixture();
    await f.manager.startManaged('10001');
    let fail: (error: Error) => void = () => {};
    f.backends[0]!.health = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const health = f.manager.resume();
    const rejected = expect(health).rejects.toThrow('old-health');
    await f.manager.startManaged('10002');
    fail(new Error('old-health'));
    await rejected;
    expect(f.manager.snapshot()).toMatchObject({ phase: 'awaiting-login', error: null, pid: 101 });
    await f.manager.stop();
  });

  it('关闭失败保留真实进程身份且不启动另一个后端，后续可以重试关闭', async () => {
    const f = fixture();
    await f.manager.startManaged('10001');
    f.backends[0]!.close.mockRejectedValueOnce(new Error('close-failed'));
    expect(await f.manager.startManaged('10002')).toMatchObject({
      phase: 'failed',
      error: 'close-failed',
      pid: 100,
      owned: true,
    });
    expect(f.backends).toHaveLength(1);
    await f.manager.stop();
    expect(f.backends[0]!.close).toHaveBeenCalledTimes(2);
    expect(f.manager.snapshot().phase).toBe('stopped');
  });

  it('手动停止失败会发布失败状态并保留清理句柄', async () => {
    const f = fixture();
    await f.manager.startManaged();
    f.backends[0]!.close.mockRejectedValueOnce(new Error('stop-failed'));
    await expect(f.manager.stop()).rejects.toThrow('stop-failed');
    expect(f.manager.snapshot()).toMatchObject({
      phase: 'failed',
      error: 'stop-failed',
      pid: 100,
      owned: true,
    });
    await f.manager.stop();
  });
});
