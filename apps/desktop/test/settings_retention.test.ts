import { act, createElement as h, useEffect, useId } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog, type SectionId } from '../src/renderer/src/components/SettingsDialog';
import { SETTINGS_GROUPS } from '../src/renderer/src/components/settings/navigation';
import { useTabActive } from '../src/renderer/src/components/RetainedTabs';
import { useAppLock } from '../src/renderer/src/state/lock';
import { useViewState } from '../src/renderer/src/state/view';
import type { SettingsSearchTarget } from '../src/renderer/src/components/settings/searchTarget';
import { PageSnapshots } from '../src/renderer/src/components/PageSnapshots';

const fixture = vi.hoisted(() => ({
  queries: new Map<string, { path: string; active: boolean; enabled: boolean }>(),
  subscriptions: new Map<string, { path: string; active: boolean; enabled: boolean }>(),
  reads: vi.fn(),
  listeners: new Set<string>(),
  mcpPort: undefined as number | undefined,
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) => {
        const name = path.join('.');
        if (key === 'useQuery' || key === 'useSubscription')
          return (_input: unknown, options?: { enabled?: boolean }) => {
            const id = useId(),
              active = useTabActive();
            const entries = key === 'useQuery' ? fixture.queries : fixture.subscriptions;
            useEffect(() => {
              entries.set(id, { path: name, active, enabled: options?.enabled !== false });
              return () => {
                entries.delete(id);
              };
            }, [entries, name, id, active, options?.enabled]);
            return {
              data:
                path.at(-1) === 'getAccountConfig'
                  ? {
                      uin: '10001',
                      configId: 'synthetic',
                      dbKey: 'synthetic-db-secret',
                      static: false,
                      nativeMediaEnabled: false,
                      rkeys: [],
                      session: { a2: 'synthetic-session-secret' },
                      clientKey: {
                        clientKey: 'synthetic-client-secret',
                        keyIndex: 1,
                        fetchedAt: 1,
                        ttlSeconds: 1,
                      },
                    }
                  : path.at(-1) === 'getMcpStatus' && fixture.mcpPort !== undefined
                    ? {
                        enabled: false,
                        running: false,
                        port: fixture.mcpPort,
                        token: 'synthetic-mcp-secret',
                        host: '127.0.0.1',
                        url: 'http://127.0.0.1/fixture',
                      }
                    : undefined,
              isLoading: false,
              isFetching: false,
              refetch: vi.fn(async () => ({ data: undefined })),
            };
          };
        if (key === 'useMutation')
          return () => ({
            mutate: vi.fn(),
            mutateAsync: vi.fn(async () => ({})),
            isLoading: false,
            isPending: false,
          });
        if (key === 'query')
          return async () => {
            fixture.reads(name);
            return undefined;
          };
        if (key === 'subscribe')
          return () => {
            const id = `${name}:${fixture.listeners.size}`;
            fixture.listeners.add(id);
            return { unsubscribe: () => fixture.listeners.delete(id) };
          };
        return proxy([...path, String(key)]);
      },
    });
  return { trpc: proxy(), client: proxy() };
});

afterEach(() => {
  useAppLock.setState({ locked: false });
  useViewState.getState().setOpenedUin(null);
  fixture.queries.clear();
  fixture.subscriptions.clear();
  fixture.listeners.clear();
  vi.unstubAllGlobals();
  fixture.mcpPort = undefined;
});
function mount(initialSection: SectionId = 'global') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('10001');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = (
    section: SectionId | undefined,
    searchTarget?: SettingsSearchTarget,
    generation = 0,
  ) =>
    act(() =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(
            PageSnapshots,
            { scope: 'synthetic-account' },
            h(SettingsDialog, {
              key: generation,
              open: true,
              initialSection: section,
              searchTarget,
              onClose: vi.fn(),
              onOpenMaintenance: vi.fn(),
              onOpenRecalls: vi.fn(),
            }),
          ),
        ),
      ),
    );
  render(initialSection);
  return {
    host,
    render,
    body: () => host.querySelector<HTMLElement>('.weq-settings-body')!,
    dispose: () => {
      act(() => root.unmount());
      client.clear();
      host.remove();
    },
  };
}
function inputValue(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('设置二级页现场与活动生命周期', () => {
  it('重建设置页时没有显式跳转目标，恢复上次分类而非覆盖成外观页', () => {
    const f = mount('appearance');
    try {
      f.render('mcp');
      expect(f.body().querySelector('[aria-label="MCP 端口"]')).not.toBeNull();
      f.render(undefined, undefined, 1);
      expect(f.body().querySelector('[aria-label="MCP 端口"]')).not.toBeNull();
    } finally {
      f.dispose();
    }
  });
  it('已读回确认的端口不再作为未保存草稿，后续重建跟随新的服务端值', () => {
    fixture.mcpPort = 48765;
    const f = mount('mcp');
    try {
      inputValue(f.body().querySelector<HTMLInputElement>('[aria-label="MCP 端口"]')!, '4567');
      fixture.mcpPort = 4567;
      f.render('mcp');
      f.render('appearance');
      fixture.mcpPort = 9999;
      f.render('mcp');
      expect(f.body().querySelector<HTMLInputElement>('[aria-label="MCP 端口"]')!.value).toBe(
        '9999',
      );
    } finally {
      f.dispose();
    }
  });
  it('锁屏释放设置内容和局部工具，解锁重建且不重新打开工具', () => {
    const f = mount('database-tolerance');
    try {
      const body = f.body();
      act(() =>
        body
          .querySelector<HTMLButtonElement>('[data-setting-id="tolerance-records"] button')!
          .click(),
      );
      expect(document.querySelector('.weq-tool-modal')).not.toBeNull();
      act(() => useAppLock.setState({ locked: true }));
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
      act(() => useAppLock.setState({ locked: false }));
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
      expect(f.body()).not.toBe(body);
    } finally {
      f.dispose();
    }
  });
  it('服务器重读不覆盖端口草稿，MCP 令牌重新进入时仍掩码', () => {
    fixture.mcpPort = 48765;
    const f = mount('mcp');
    try {
      const body = f.body(),
        input = body.querySelector<HTMLInputElement>('[aria-label="MCP 端口"]')!;
      inputValue(input, '4567');
      act(() => body.querySelector<HTMLButtonElement>('[aria-label="显示令牌"]')!.click());
      expect(body.textContent).toContain('synthetic-mcp-secret');
      f.render('appearance');
      fixture.mcpPort = 9999;
      f.render('mcp');
      expect(f.body()).not.toBe(body);
      expect(f.body().querySelector<HTMLInputElement>('[aria-label="MCP 端口"]')!.value).toBe(
        '4567',
      );
      expect(f.body().innerHTML).not.toContain('synthetic-mcp-secret');
    } finally {
      f.dispose();
    }
  });
  it('重建恢复滚动与旧高亮但不抢焦点，新的搜索仍可重新定位', async () => {
    const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scroll,
    });
    const f = mount('global');
    try {
      const target = { section: 'global', item: '成功通知停留时长', revision: 1 } as const;
      f.render('global', target);
      const body = f.body(),
        setting = body.querySelector<HTMLElement>('[data-search-highlight]')!;
      act(() => {
        body.scrollTop = 143;
        body.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      act(() =>
        [...f.host.querySelectorAll<HTMLButtonElement>('.weq-settings-subnav-item')]
          .find((button) => button.textContent === '主题与背景')!
          .click(),
      );
      const back = [
        ...f.host.querySelectorAll<HTMLButtonElement>('.weq-settings-subnav-item'),
      ].find((button) => button.textContent === '提醒与窗口')!;
      act(() => {
        back.focus();
        back.click();
      });
      expect(f.body()).not.toBe(body);
      Object.defineProperty(f.body(), 'scrollHeight', { value: 1000 });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(f.body().scrollTop).toBe(143);
      expect(document.activeElement).toBe(back);
      const restoredSetting = f.body().querySelector<HTMLElement>('[data-search-highlight]')!;
      expect(restoredSetting.dataset.searchHighlight).toBe('true');
      expect(scroll.mock.contexts.filter((context) => context === setting)).toHaveLength(1);
      f.render('global', { ...target, revision: 2 });
      expect(scroll.mock.contexts.filter((context) => context === restoredSetting)).toHaveLength(1);
      expect(document.activeElement).toBe(restoredSetting);
    } finally {
      f.dispose();
      if (previous) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previous);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });
  it('只挂载当前页，重建恢复输入、展开与滚动，不让旧页继续查询', async () => {
    const f = mount();
    try {
      const body = f.body(),
        input = body.querySelector<HTMLInputElement>('input')!;
      inputValue(input, '73');
      act(() => {
        body.scrollTop = 137;
        body.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      f.render('database-tolerance');
      const databaseBody = f.body();
      const details = databaseBody.querySelector('details')!;
      act(() => {
        details.open = true;
      });
      f.render('global');
      expect(f.body()).not.toBe(body);
      expect(f.body().querySelector('input')).not.toBe(input);
      expect(f.body().querySelector('input')!.value).toBe('73');
      Object.defineProperty(f.body(), 'scrollHeight', { value: 1000 });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(f.body().scrollTop).toBe(137);
      f.render('database-tolerance');
      expect(f.body()).not.toBe(databaseBody);
      expect(f.body().querySelector('details')!.open).toBe(true);
      expect(f.host.querySelectorAll('[data-retained-panel]')).toHaveLength(1);
      expect(
        [...fixture.queries.values()].filter((query) => !query.active && query.enabled),
      ).toEqual([]);
    } finally {
      f.dispose();
    }
  });
  it('凭据离页与锁屏后重建为掩码，不恢复揭示状态', () => {
    const f = mount('credentials');
    try {
      const body = f.body();
      act(() => body.querySelector<HTMLButtonElement>('[aria-label="显示密钥"]')!.click());
      expect(body.textContent).toContain('synthetic-db-secret');
      f.render('appearance');
      f.render('credentials');
      expect(f.body()).not.toBe(body);
      expect(f.body().innerHTML).not.toContain('synthetic-db-secret');
      act(() => f.body().querySelector<HTMLButtonElement>('[aria-label="显示 a2"]')!.click());
      expect(f.body().textContent).toContain('synthetic-session-secret');
      act(() => useAppLock.setState({ locked: true }));
      act(() => useAppLock.setState({ locked: false }));
      expect(f.body().innerHTML).not.toContain('synthetic-session-secret');
    } finally {
      f.dispose();
    }
  });
  it('所有访问过的页仅当前页启用查询和模型订阅；锁屏时全部暂停', async () => {
    const f = mount('appearance');
    try {
      for (const section of SETTINGS_GROUPS.flatMap((group) => group.sections)) {
        await act(async () => {
          f.render(section);
        });
        expect(f.host.querySelectorAll('.weq-settings-body')).toHaveLength(1);
        expect(
          [...fixture.queries.values()].filter((query) => !query.active && query.enabled),
          section,
        ).toEqual([]);
        expect(
          [...fixture.subscriptions.values()].filter((query) => !query.active && query.enabled),
          section,
        ).toEqual([]);
      }
      expect(f.host.querySelectorAll('.weq-settings-pages > [data-retained-panel]')).toHaveLength(
        1,
      );
      act(() => useAppLock.setState({ locked: true }));
      expect([...fixture.queries.values()].filter((query) => query.enabled)).toEqual([]);
      expect(fixture.listeners.size).toBe(0);
    } finally {
      f.dispose();
    }
  });
});
