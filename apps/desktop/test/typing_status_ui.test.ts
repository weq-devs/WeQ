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
  preferences: { defaultEnabled: false, overrides: [] } as TypingStatusSettings,
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
          isError: false,
        }),
      },
      setTypingStatusDefault: { useMutation: () => ({ isLoading: false }) },
      setTypingStatusOverride: {
        useMutation: () => ({
          isLoading: false,
          mutateAsync: async (input: TypingStatusSettings['overrides'][number]) => ({
            ...session.preferences,
            overrides: [
              ...session.preferences.overrides.filter(
                (item) =>
                  item.accountUin !== input.accountUin ||
                  item.accountConfigId !== input.accountConfigId ||
                  item.uid !== input.uid,
              ),
              input,
            ],
          }),
        }),
      },
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
  session.run.mockReset();
  session.send.mockReset();
  session.preferences = { defaultEnabled: false, overrides: [] };
  session.listeners.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('正在输入状态工具栏按钮', () => {
  it('显式开启后广播输入，双编辑器共用十秒节流；离线、忙碌、切号与卸载不继续发送', async () => {
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
      await input();
      expect(session.send).not.toHaveBeenCalled();
      await act(async () => host.querySelector('button')!.click());
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
      session.binding = { ...session.binding, expectedAccountConfigId: 'other-source' };
      await render();
      expect(host.querySelector('button')!.getAttribute('aria-pressed')).toBe('false');
      vi.setSystemTime(140_000);
      await input();
      expect(session.send).toHaveBeenCalledTimes(3);
      await act(async () => host.querySelector('button')!.click());
      await input();
      expect(session.send).toHaveBeenLastCalledWith({
        ...session.binding,
        uid: 'u_one',
        eventType: 1,
      });
      await render('u_two');
      await input();
      expect(session.send).toHaveBeenCalledTimes(4);
      await act(async () => host.querySelector('button')!.click());
      act(() => root.unmount());
      await input();
      expect(session.send).toHaveBeenCalledTimes(4);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it('默认关闭，点击保存并切换高亮状态，切换好友后恢复各自偏好', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    const editors = [createRef<HTMLDivElement>()];
    try {
      await act(async () => root.render(createElement(TypingStatus, { uid: 'u_one', editors })));
      const button = host.querySelector('button')!;
      expect(button.classList.contains('composer-tool')).toBe(true);
      expect(button.getAttribute('aria-label')).toBe('发送正在输入状态');
      expect(button.getAttribute('aria-pressed')).toBe('false');
      expect(host.querySelector('input[type="checkbox"]')).toBeNull();
      await act(async () => button.click());
      expect(button.getAttribute('aria-pressed')).toBe('true');
      expect(button.title).toContain('已开启');
      await act(async () => button.click());
      expect(button.getAttribute('aria-pressed')).toBe('false');
      await act(async () => button.click());
      await act(async () => root.render(createElement(TypingStatus, { uid: 'u_two', editors })));
      expect(button.getAttribute('aria-pressed')).toBe('false');
      await act(async () => root.render(createElement(TypingStatus, { uid: 'u_one', editors })));
      expect(button.getAttribute('aria-pressed')).toBe('true');
      session.available = false;
      await act(async () => root.render(createElement(TypingStatus, { uid: 'u_two', editors })));
      expect(button.disabled).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });
});
