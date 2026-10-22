import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupStartupGate } from '../src/renderer/src/components/BackupStartupGate';
import type { BackupStartupState } from '../src/renderer/src/lib/backupClientRestore';

const api = vi.hoisted(() => ({ read: vi.fn(), recover: vi.fn(), status: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: {
      backupStartup: { query: api.read },
      backupRetryRecovery: { mutate: api.recover },
      backupStatus: { query: api.status },
    },
  },
}));
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.clearAllMocks();
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
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
