import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupStartupGate } from '../src/renderer/src/components/BackupStartupGate';
import type { BackupStartupState } from '../src/renderer/src/lib/backupClientRestore';

const api = vi.hoisted(() => ({
  read: vi.fn(),
  recover: vi.fn(),
  status: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: {
      backupStartup: { query: api.read },
      backupRetryRecovery: { mutate: api.recover },
      backupStatus: { query: api.status },
      onRuntimeFilesChanged: { subscribe: api.subscribe },
    },
  },
}));
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('sessionStorage', new Storage());
  vi.clearAllMocks();
  api.subscribe.mockReturnValue({ unsubscribe() {} });
});
afterEach(() => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('启动读取和补充状态都不返回时结束加载并允许重试', async () => {
  vi.useFakeTimers();
  api.read.mockImplementationOnce(() => new Promise(() => {}));
  api.status.mockImplementationOnce(() => new Promise(() => {}));
  const host = await mount();
  await act(async () => vi.advanceTimersByTimeAsync(18_000));
  expect(host.textContent).not.toContain('正在检查恢复状态');
  expect(host.textContent).toContain('启动检查');
  expect([...host.querySelectorAll('button')].some((node) => node.textContent === '重试恢复')).toBe(
    true,
  );
  api.read.mockResolvedValue(healthy);
  await act(async () =>
    [...host.querySelectorAll('button')].find((node) => node.textContent === '重试恢复')!.click(),
  );
  expect(host.querySelector('[data-business]')).not.toBeNull();
});
const healthy: BackupStartupState = {
  ok: true,
  error: null,
  result: null,
  client: null,
  appliedThisStartup: false,
  canReveal: false,
  canRestart: false,
};
async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        BackupStartupGate,
        null,
        createElement('div', { 'data-business': true }, '合成业务视图'),
      ),
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
it('文件回滚未完成时不挂载业务视图；明确重试后再放行', async () => {
  api.read.mockResolvedValueOnce({ ...healthy, ok: false, error: '合成回滚未完成' });
  const host = await mount();
  expect(host.querySelector('[data-business]')).toBeNull();
  expect(host.textContent).toContain('合成回滚未完成');
  expect(host.textContent).not.toContain('组件版本过旧');
  api.read.mockResolvedValue(healthy);
  api.recover.mockResolvedValue(true);
  await act(async () =>
    [...host.querySelectorAll('button')].find((node) => node.textContent === '重试恢复')!.click(),
  );
  expect(api.recover).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[data-business]')).not.toBeNull();
});
it('普通读取故障只重试读取，不重建健康的文件或业务上下文', async () => {
  api.read.mockRejectedValueOnce(Error('synthetic-offline'));
  api.status.mockResolvedValue({ pending: null, result: null });
  const host = await mount();
  api.read.mockResolvedValue(healthy);
  await act(async () =>
    [...host.querySelectorAll('button')].find((node) => node.textContent === '重试恢复')!.click(),
  );
  expect(api.recover).not.toHaveBeenCalled();
  expect(host.querySelector('[data-business]')).not.toBeNull();
});

it.each([false, true])(
  '恢复或重置完成后直接显示原页面（偏好待交接：%s）',
  async (clientPending) => {
    api.read.mockResolvedValue({
      ...healthy,
      appliedThisStartup: true,
      result: {
        id: 'synthetic-restore',
        status: 'applied',
        applied: ['settings'],
        skipped: [],
        warnings: ['合成恢复提示'],
        clientPending,
      },
    });
    const host = await mount();
    expect(host.querySelector('[data-business]')).not.toBeNull();
    expect(host.textContent).not.toContain('备份恢复已应用');
    expect(host.textContent).not.toContain('继续');
    expect(localStorage.getItem('weq.backup-result-seen')).toBeNull();
  },
);

it('运行态版本变化才刷新；失败原因跨界面刷新保留，重试读取后可继续', async () => {
  api.read.mockResolvedValue(healthy);
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  await mount();
  const events = api.subscribe.mock.calls[0]![1] as {
    onData: (state: { state: string; revision: number; error?: string }) => void;
  };
  events.onData({ state: 'ready', revision: 0 });
  events.onData({ state: 'ready', revision: 0 });
  expect(reload).not.toHaveBeenCalled();
  events.onData({ state: 'ready', revision: 1, error: '合成后台保存失败' });
  expect(reload).toHaveBeenCalledOnce();
  const host = await mount();
  expect(host.textContent).toContain('合成后台保存失败');
  expect(host.querySelector('[data-business]')).toBeNull();
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === '重试恢复')!
      .click(),
  );
  expect(host.querySelector('[data-business]')).not.toBeNull();
});
