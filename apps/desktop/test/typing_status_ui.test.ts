import { act, createElement, createRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypingStatus } from '../src/renderer/src/components/qq-actions/ChatActions';
import type { TypingStatusSettings } from '@weq/service';

const session = vi.hoisted(() => ({
  available: true,
  busy: false,
  binding: { expectedAccountUin: '10000', expectedAccountConfigId: 'test' },
  result: null,
  run: vi.fn(),
  send: vi.fn(),
  preferences: { mode: 'off', hidden: [] } as TypingStatusSettings,
  error: false,
  listeners: new Set<() => void>(),
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => session,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { qqActions: { inputStatus: { mutate: session.send } } } },
  trpc: {
    bootstrap: {
      getTypingStatusSettings: {
        useQuery: () => ({
          data: useSyncExternalStore(
            (listener) => {
              session.listeners.add(listener);
              return () => {
                session.listeners.delete(listener);
              };
            },
            () => session.preferences,
          ),
          isError: session.error,
        }),
      },
      setTypingStatusMode: { useMutation: () => ({ isLoading: false }) },
      setTypingStatusHidden: { useMutation: () => ({ isLoading: false }) },
    },
    useUtils: () => ({
      bootstrap: {
        getTypingStatusSettings: {
          cancel: async () => {},
          setData: (_input: undefined, next: TypingStatusSettings) => {
            session.preferences = next;
            for (const listener of session.listeners) listener();
          },
        },
        getSettings: { invalidate: async () => {} },
      },
    }),
  },
}));

afterEach(() => {
  session.available = true;
  session.busy = false;
  session.binding = { expectedAccountUin: '10000', expectedAccountConfigId: 'test' };
  session.error = false;
  session.run.mockReset();
  session.send.mockReset();
  session.preferences = { mode: 'off', hidden: [] };
  session.listeners.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('私聊正在输入状态广播', () => {
  it('默认展示：输入框不再有开关按钮，仍有输入时按十秒节流广播', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100_000);
    session.run.mockImplementation(
      async (task: (binding: typeof session.binding) => Promise<unknown>) => task(session.binding),
    );
    session.send.mockResolvedValue({ ok: true });
    const host = document.createElement('div');
    const root = createRoot(host);
    const editors = [createRef<HTMLDivElement>(), createRef<HTMLDivElement>()];
    for (const ref of editors) ref.current = document.createElement('div');
    const input = (index = 0) =>
      act(async () => {
        editors[index]!.current!.dispatchEvent(new Event('input'));
      });
    const render = (uid = 'u_one') =>
      act(async () => root.render(createElement(TypingStatus, { uid, editors })));
    try {
      await render();
      expect(host.querySelector('button')).toBeNull();
      await input();
      await input(1);
      expect(session.send).toHaveBeenCalledTimes(1);
      expect(session.send).toHaveBeenCalledWith({ ...session.binding, uid: 'u_one', eventType: 1 });
      expect(session.run.mock.calls[0]?.slice(1)).toEqual([undefined, { refreshCaches: false }]);
      vi.setSystemTime(109_999);
      await input();
      expect(session.send).toHaveBeenCalledTimes(1);
      vi.setSystemTime(110_000);
      await input(1);
      expect(session.send).toHaveBeenCalledTimes(2);
      vi.setSystemTime(120_000);
      session.busy = true;
      await input();
      session.busy = false;
      session.available = false;
      await input();
      expect(session.send).toHaveBeenCalledTimes(2);
      session.available = true;
      await input();
      expect(session.send).toHaveBeenCalledTimes(3);
      act(() => root.unmount());
      await input();
      expect(session.send).toHaveBeenCalledTimes(3);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('永久全选时全部不广播，关闭范围恢复广播', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    const editors = [createRef<HTMLDivElement>()];
    editors[0]!.current = document.createElement('div');
    const input = () => act(async () => editors[0]!.current!.dispatchEvent(new Event('input')));
    try {
      session.run.mockImplementation(
        async (task: (binding: typeof session.binding) => Promise<unknown>) =>
          task(session.binding),
      );
      session.preferences = { mode: 'all', hidden: [] };
      await act(async () => root.render(createElement(TypingStatus, { uid: 'u_one', editors })));
      await input();
      expect(session.send).not.toHaveBeenCalled();
      session.preferences = { mode: 'off', hidden: [] };
      await act(async () => root.render(createElement(TypingStatus, { uid: 'u_one', editors })));
      await input();
      expect(session.send).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('按会话勾选只隐藏命中的会话，且按账号与数据源隔离', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    const editors = [createRef<HTMLDivElement>()];
    editors[0]!.current = document.createElement('div');
    const input = () => act(async () => editors[0]!.current!.dispatchEvent(new Event('input')));
    try {
      session.run.mockImplementation(
        async (task: (binding: typeof session.binding) => Promise<unknown>) =>
          task(session.binding),
      );
      session.preferences = {
        mode: 'selected',
        hidden: [
          {
            accountUin: '10000',
            accountConfigId: 'test',
            uid: 'u_hidden',
            name: '被隐藏的会话',
          },
        ],
      };
      await act(async () => root.render(createElement(TypingStatus, { uid: 'u_hidden', editors })));
      await input();
      expect(session.send).not.toHaveBeenCalled();
      await act(async () =>
        root.render(createElement(TypingStatus, { uid: 'u_visible', editors })),
      );
      await input();
      expect(session.send).toHaveBeenCalledTimes(1);
      // 另一数据源的同名 uid 不受这条隐藏记录影响。
      session.binding = { ...session.binding, expectedAccountConfigId: 'other-source' };
      await act(async () => root.render(createElement(TypingStatus, { uid: 'u_hidden', editors })));
      await input();
      expect(session.send).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('读取失败时不广播，恢复后按当前设置继续', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    const editors = [createRef<HTMLDivElement>()];
    editors[0]!.current = document.createElement('div');
    try {
      session.run.mockImplementation(
        async (task: (binding: typeof session.binding) => Promise<unknown>) =>
          task(session.binding),
      );
      session.error = true;
      await act(async () => root.render(createElement(TypingStatus, { uid: 'u_one', editors })));
      await act(async () => editors[0]!.current!.dispatchEvent(new Event('input')));
      expect(session.send).not.toHaveBeenCalled();
      session.error = false;
      await act(async () => root.render(createElement(TypingStatus, { uid: 'u_one', editors })));
      await act(async () => editors[0]!.current!.dispatchEvent(new Event('input')));
      expect(session.send).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
