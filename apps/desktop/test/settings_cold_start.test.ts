import { act, createElement as h, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { MainView } from '../src/renderer/src/views/MainView';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
import { useViewState } from '../src/renderer/src/state/view';
import { SettingsDialog } from '../src/renderer/src/components/lazyWorkspaces';

const fixture = vi.hoisted(() => ({ configId: '' }));
vi.mock('../src/renderer/src/trpc/client', () => {
  const refetch = vi.fn(async () => ({ data: undefined }));
  const empty = { data: undefined, isLoading: false, isFetching: false, refetch };
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) => {
        if (key === 'useQuery')
          return () =>
            path.join('.') === 'account.getAccountConfig'
              ? {
                  ...empty,
                  data: fixture.configId
                    ? { uin: '10001', configId: fixture.configId, static: false }
                    : undefined,
                }
              : empty;
        if (key === 'useInfiniteQuery') return () => empty;
        if (key === 'useMutation')
          return () => ({ mutate: vi.fn(), mutateAsync: refetch, isLoading: false });
        if (key === 'useSubscription') return () => {};
        if (key === 'query' || key === 'mutate' || key === 'invalidate')
          return async () => undefined;
        if (key === 'subscribe') return () => ({ unsubscribe: vi.fn() });
        return proxy([...path, String(key)]);
      },
    });
  return { trpc: proxy(), client: proxy() };
});
vi.mock('../src/renderer/src/im-template/template/chatShell', () => ({
  ChatShell: ({
    mainContent,
    children,
    onOpenSettings,
  }: {
    mainContent: ReactNode;
    children: ReactNode;
    onOpenSettings: () => void;
  }) =>
    h(
      'div',
      null,
      h('button', { onClick: onOpenSettings, 'aria-label': '打开设置' }, '设置'),
      mainContent,
      children,
    ),
}));

afterEach(() => {
  useViewState.getState().setOpenedUin(null);
  fixture.configId = '';
  vi.unstubAllGlobals();
});

it('冷启动打开设置和切换数据源后重新打开，均只保留一个设置实例', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('10001');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const consoleError = vi.spyOn(console, 'error');
  const render = () =>
    act(async () =>
      root.render(
        h(
          StrictMode,
          null,
          h(
            QueryClientProvider,
            { client: queryClient },
            h(ContentSelectionProvider, null, h(MainView)),
          ),
        ),
      ),
    );
  try {
    await render();
    await act(async () => {
      await SettingsDialog.preload();
      host.querySelector<HTMLButtonElement>('[aria-label="打开设置"]')!.click();
    });
    expect(host.querySelectorAll('.weq-settings-dialog')).toHaveLength(1);
    const initial = host.querySelector('.weq-settings-dialog');
    const body = host.querySelector<HTMLElement>('.weq-settings-body')!;
    body.scrollTop = 120;
    await render();
    expect(host.querySelector('.weq-settings-dialog')).toBe(initial);
    expect(body.scrollTop).toBe(120);
    for (const configId of ['source-a', 'source-b', 'source-a', '', 'source-a']) {
      fixture.configId = configId;
      await render();
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[aria-label="打开设置"]')!.click(),
      );
      expect(host.querySelectorAll('.weq-settings-dialog')).toHaveLength(1);
      expect(host.querySelectorAll('.weq-workspace-page')).toHaveLength(1);
      expect(host.querySelector('.weq-settings-dialog')).not.toBe(initial);
      expect(initial?.isConnected).toBe(false);
    }
    await act(async () => {});
    act(() => host.querySelector<HTMLButtonElement>('.weq-settings-close')!.click());
    expect(host.querySelector('.weq-settings-dialog')).toBeNull();
    expect(host.querySelector('.weq-workspace-page')).toBeNull();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="打开设置"]')!.click(),
    );
    expect(host.querySelectorAll('.weq-settings-dialog')).toHaveLength(1);
    expect(host.querySelectorAll('.weq-workspace-page')).toHaveLength(1);
    expect(consoleError.mock.calls.filter((args) => String(args[0]).includes('same key'))).toEqual(
      [],
    );
  } finally {
    act(() => root.unmount());
    queryClient.clear();
    host.remove();
    consoleError.mockRestore();
  }
});
