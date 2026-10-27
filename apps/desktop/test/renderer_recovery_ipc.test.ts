// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { registerRendererRecoveryIpc } from '../src/main/renderer_recovery_ipc';
import { createRendererRecovery } from '../src/main/renderer_recovery';

const state = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: state.handle } }));

it('恢复事件只有当前主 frame 可领取，未知来源/子 frame 不消费，确认只接受整数 id', () => {
  const recovery = createRendererRecovery({
    unavailable: () => false,
    quitting: () => false,
    showDialog: async () => 2,
    reload() {},
    quit() {},
    record() {},
  });
  const rendererReady = vi.spyOn(recovery, 'rendererReady').mockReturnValue({ id: 1 });
  const acknowledgeNotice = vi.spyOn(recovery, 'acknowledgeNotice');
  registerRendererRecoveryIpc((sender) => (sender.id === 1 ? recovery : undefined));
  const invoke = (name: string, event: unknown, argument?: unknown) => {
    const handler = state.handle.mock.calls.find((call) => call[0] === name)![1] as (
      event: unknown,
      value?: unknown,
    ) => unknown;
    return handler(event, argument);
  };
  const frame = {};
  const event = { sender: { id: 1, mainFrame: frame }, senderFrame: frame };
  expect(invoke('renderer-recovery:notice', { ...event, senderFrame: {} })).toBeNull();
  expect(
    invoke('renderer-recovery:notice', { ...event, sender: { id: 2, mainFrame: frame } }),
  ).toBeNull();
  expect(rendererReady).not.toHaveBeenCalled();
  expect(invoke('renderer-recovery:notice', event)).toEqual({ id: 1 });
  invoke('renderer-recovery:acknowledge', event, '1');
  invoke('renderer-recovery:acknowledge', event, Number.NaN);
  invoke('renderer-recovery:acknowledge', { ...event, senderFrame: {} }, 1);
  expect(acknowledgeNotice).not.toHaveBeenCalled();
  invoke('renderer-recovery:acknowledge', event, 1);
  expect(acknowledgeNotice).toHaveBeenCalledWith(1);
});
