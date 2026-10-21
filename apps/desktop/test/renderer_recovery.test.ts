import { describe, expect, it, vi } from 'vitest';
import { createRendererRecovery } from '../src/main/renderer_recovery';

function fixture() {
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
