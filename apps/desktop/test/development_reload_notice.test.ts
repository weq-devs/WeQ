import { beforeEach, expect, it, vi } from 'vitest';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import {
  installDevelopmentReloadNotice,
  type DevelopmentReloadNoticeState,
} from '../src/renderer/src/lib/developmentReloadNotice';
import {
  DEVELOPMENT_RELOAD_APPLY,
  DEVELOPMENT_RELOAD_DISMISS,
  DEVELOPMENT_RELOAD_QUERY,
  DEVELOPMENT_RELOAD_STATUS,
  type DevelopmentReloadStatus,
} from '../src/shared/development_reload';

beforeEach(() => useToast.setState({ toasts: [], leaving: [], seq: 0 }));

function fixture(state: DevelopmentReloadNoticeState = {}, remoteNotice?: (id: string) => void) {
  let receive: (status: DevelopmentReloadStatus | null) => void = () => {};
  const channel = {
    on: vi.fn((_event, listener) => {
      receive = listener;
    }),
    off: vi.fn(),
    send: vi.fn(),
  };
  const dispose = installDevelopmentReloadNotice(channel, state, remoteNotice);
  return { channel, dispose, receive: (status: DevelopmentReloadStatus | null) => receive(status) };
}

it('Remote 重载后不查询上一批 HMR 状态，仍接收新到的更新', () => {
  const notify = vi.fn();
  const first = fixture({}, notify);
  const previous = { id: 'one', ready: true, restart: false };
  first.receive(previous);
  expect(notify.mock.calls).toEqual([['one']]);
  first.dispose();

  const reloaded = fixture({}, notify);
  expect(reloaded.channel.send).not.toHaveBeenCalled();
  expect(notify.mock.calls).toEqual([['one']]);
  reloaded.receive({ ...previous, id: 'two' });
  expect(notify.mock.calls).toEqual([['one'], ['two']]);
  reloaded.dispose();
});

it('相同批次原位合并，重启优先，重复点击只发送一次', () => {
  const { channel, receive } = fixture();
  expect(channel.send).toHaveBeenCalledWith(DEVELOPMENT_RELOAD_QUERY);
  receive({ id: 'one', ready: true, restart: false });
  const first = useToast.getState().toasts[0]!;
  receive({ id: 'one', ready: true, restart: true });
  const toasts = useToast.getState().toasts;
  expect(toasts).toHaveLength(1);
  expect(toasts[0]!.id).toBe(first.id);
  expect(toasts[0]!.title).toContain('点击重启');
  toasts[0]!.action!.run();
  toasts[0]!.action!.run();
  expect(channel.send.mock.calls.filter(([event]) => event === DEVELOPMENT_RELOAD_APPLY)).toEqual([
    [DEVELOPMENT_RELOAD_APPLY, { id: 'one' }],
  ]);
});

it('关闭后、重连及热替换重装均不复活同批横幅，新批次可以提示', () => {
  const state: DevelopmentReloadNoticeState = {};
  const first = fixture(state);
  const status = { id: 'one', ready: true, restart: false };
  first.receive(status);
  const id = useToast.getState().toasts[0]!.id;
  useToast.getState().dismiss(id, 'manual');
  expect(first.channel.send).toHaveBeenCalledWith(DEVELOPMENT_RELOAD_DISMISS, { id: 'one' });
  first.receive(status);
  expect(useToast.getState().leaving).toContain(id);
  useToast.getState().remove(id);
  first.dispose();
  expect(first.channel.off).toHaveBeenCalledWith(DEVELOPMENT_RELOAD_STATUS, expect.any(Function));
  const second = fixture(state);
  second.receive({ ...status, dismissed: true });
  expect(useToast.getState().toasts).toHaveLength(0);
  second.receive(null);
  second.receive({ ...status, id: 'two' });
  expect(useToast.getState().toasts).toHaveLength(1);
});

it('构建未就绪时清除动作，旧按钮闭包也不能应用；成功后恢复', () => {
  const { channel, receive } = fixture();
  receive({ id: 'one', ready: true, restart: true });
  const run = useToast.getState().toasts[0]!.action!.run;
  receive({ id: 'one', ready: false, restart: true });
  expect(useToast.getState().toasts[0]!.action).toBeUndefined();
  run();
  expect(channel.send).toHaveBeenCalledTimes(1);
  receive({ id: 'one', ready: true, restart: true });
  run();
  expect(channel.send).toHaveBeenCalledWith(DEVELOPMENT_RELOAD_APPLY, { id: 'one' });
  receive(null);
  expect(useToast.getState().leaving).toContain(useToast.getState().toasts[0]!.id);
});
