// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRendererRecovery,
  RENDERER_AUTO_RELOAD_DELAY_MS,
  RENDERER_AUTO_RELOAD_COOLDOWN_MS,
  RENDERER_RELOAD_TIMEOUT_MS,
} from '../src/main/renderer_recovery';

function fixture(automatic = false) {
  let resolveDialog: (choice: number) => void = () => {};
  let unavailable = false;
  let quitting = false;
  const showDialog = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        resolveDialog = resolve;
      }),
  );
  const reload = vi.fn();
  const quit = vi.fn();
  const record = vi.fn();
  const recovery = createRendererRecovery({
    automatic,
    now: () => Date.now(),
    unavailable: () => unavailable,
    quitting: () => quitting,
    showDialog,
    reload,
    quit,
    record,
  });
  return {
    recovery,
    showDialog,
    reload,
    quit,
    record,
    choose: async (choice: number) => {
      resolveDialog(choice);
      await Promise.resolve();
    },
    destroy: () => {
      unavailable = true;
      recovery.dispose();
    },
    shutdown: () => {
      quitting = true;
    },
  };
}

describe('主界面崩溃恢复', () => {
  it('退出事件记录脱敏原因和退出码，同一次提示不重复打开', async () => {
    const f = fixture();
    f.recovery.gone({ reason: 'oom', exitCode: 9 });
    expect(f.recovery.needsRecovery()).toBe(true);
    f.recovery.request();
    f.recovery.gone({ reason: 'oom', exitCode: 9 });
    expect(f.showDialog).toHaveBeenCalledTimes(1);
    expect(f.record).toHaveBeenCalledWith('gone', { reason: 'oom', exitCode: 9 });
    expect(f.reload).not.toHaveBeenCalled();
    await f.choose(0);
    expect(f.reload).toHaveBeenCalledTimes(1);
    expect(f.recovery.needsRecovery()).toBe(true);
    f.recovery.loaded();
    expect(f.recovery.needsRecovery()).toBe(false);
  });

  it('稍后处理后关闭窗口仍可打开原生恢复，而非依赖渲染 IPC', async () => {
    const f = fixture();
    f.recovery.gone({ reason: 'crashed', exitCode: 1 });
    await f.choose(2);
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.quit).not.toHaveBeenCalled();
    f.recovery.request();
    expect(f.showDialog).toHaveBeenCalledTimes(2);
    await f.choose(1);
    expect(f.quit).toHaveBeenCalledTimes(1);
  });

  it('恢复加载、窗口销毁或退出后不执行旧提示结果', async () => {
    for (const end of ['load', 'destroy', 'quit'] as const) {
      const f = fixture();
      f.recovery.gone({ reason: 'killed', exitCode: 1 });
      if (end === 'load') f.recovery.loaded();
      if (end === 'destroy') f.destroy();
      if (end === 'quit') f.shutdown();
      await f.choose(0);
      expect(f.reload).not.toHaveBeenCalled();
      expect(f.quit).not.toHaveBeenCalled();
    }
  });

  it('未知原因不把任意字符串写日志，退出期间不弹框', () => {
    const f = fixture();
    f.shutdown();
    f.recovery.gone({ reason: 'https://private.invalid/?token=secret', exitCode: 1 });
    expect(f.record).toHaveBeenCalledWith('gone', { reason: 'unknown', exitCode: 1 });
    expect(f.showDialog).not.toHaveBeenCalled();
  });

  it('原生提示失败可从关闭入口重试，不自动重载', async () => {
    const f = fixture();
    f.showDialog.mockRejectedValueOnce(new Error('private details'));
    f.recovery.gone({ reason: 'oom', exitCode: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.record).toHaveBeenCalledWith('dialog-failed');
    f.recovery.request();
    expect(f.showDialog).toHaveBeenCalledTimes(2);
    expect(f.reload).not.toHaveBeenCalled();
    await f.choose(2);
  });
});

afterEach(() => vi.useRealTimers());

describe('有界自动恢复', () => {
  it('首次崩溃自动恢复，加载完成不重置冷却，连续崩溃转为手动', async () => {
    vi.useFakeTimers();
    const f = fixture(true);
    f.recovery.gone({ reason: 'crashed', exitCode: 5 });
    f.recovery.gone({ reason: 'crashed', exitCode: 5 });
    expect(f.showDialog).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RENDERER_AUTO_RELOAD_DELAY_MS);
    expect(f.reload).toHaveBeenCalledTimes(1);
    expect(f.record).toHaveBeenCalledWith('auto-reload');
    f.recovery.loaded();
    f.recovery.gone({ reason: 'oom', exitCode: 5 });
    expect(f.showDialog).toHaveBeenCalledTimes(1);
    await f.choose(2);
    f.recovery.loaded();
    await vi.advanceTimersByTimeAsync(RENDERER_AUTO_RELOAD_COOLDOWN_MS);
    f.recovery.gone({ reason: 'oom', exitCode: 5 });
    await vi.advanceTimersByTimeAsync(RENDERER_AUTO_RELOAD_DELAY_MS);
    expect(f.reload).toHaveBeenCalledTimes(2);
    f.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('重载无完成回执、加载失败或重载抛错时回到原生恢复入口', async () => {
    for (const failure of ['timeout', 'failed', 'throw', 'crash'] as const) {
      vi.useFakeTimers();
      const f = fixture(true);
      if (failure === 'throw')
        f.reload.mockImplementation(() => {
          throw new Error('private');
        });
      f.recovery.gone({ reason: 'oom', exitCode: 5 });
      await vi.advanceTimersByTimeAsync(RENDERER_AUTO_RELOAD_DELAY_MS);
      if (failure === 'failed') f.recovery.failed();
      if (failure === 'crash') f.recovery.gone({ reason: 'crashed', exitCode: 5 });
      if (failure === 'timeout') await vi.advanceTimersByTimeAsync(RENDERER_RELOAD_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.showDialog).toHaveBeenCalledTimes(1);
      expect(f.reload).toHaveBeenCalledTimes(1);
      expect(f.recovery.needsRecovery()).toBe(true);
      f.destroy();
      await f.choose(0);
      expect(f.reload).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('加载完成、销毁和退出取消延迟恢复；手动介入不与自动重载竞争', async () => {
    vi.useFakeTimers();
    for (const end of ['load', 'destroy', 'quit', 'manual'] as const) {
      const f = fixture(true);
      f.recovery.gone({ reason: 'oom', exitCode: 5 });
      if (end === 'load') f.recovery.loaded();
      if (end === 'destroy') f.destroy();
      if (end === 'quit') f.shutdown();
      if (end === 'manual') {
        f.recovery.request();
        await f.choose(2);
      }
      await vi.advanceTimersByTimeAsync(RENDERER_AUTO_RELOAD_DELAY_MS + RENDERER_RELOAD_TIMEOUT_MS);
      expect(f.reload).not.toHaveBeenCalled();
      expect(f.showDialog).toHaveBeenCalledTimes(end === 'manual' ? 1 : 0);
      f.destroy();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('主动终止、启动失败和未知原因不自动重载', () => {
    vi.useFakeTimers();
    for (const reason of [
      'killed',
      'launch-failed',
      'integrity-failure',
      'clean-exit',
      'unknown',
    ]) {
      const f = fixture(true);
      f.recovery.gone({ reason, exitCode: 1 });
      expect(f.showDialog).toHaveBeenCalledTimes(1);
      expect(f.reload).not.toHaveBeenCalled();
      f.destroy();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('手动重载同步失败后不遗留对话框占用，也不额外启动自动重试', async () => {
    vi.useFakeTimers();
    const f = fixture(true);
    f.reload.mockImplementation(() => {
      throw new Error('private details');
    });
    f.recovery.gone({ reason: 'launch-failed', exitCode: 1 });
    await f.choose(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.showDialog).toHaveBeenCalledTimes(2);
    expect(f.reload).toHaveBeenCalledTimes(1);
    await f.choose(2);
    f.recovery.request();
    expect(f.showDialog).toHaveBeenCalledTimes(3);
    f.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
