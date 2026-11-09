import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ActiveWidgetProvider, useActiveWidget } from '../src/renderer/src/hooks/useActiveWidget';

const fixture = vi.hoisted(() => ({ fetchState: vi.fn() }));

vi.mock('../src/renderer/src/trpc/client', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  return {
    trpc: {
      account: {
        dressup: {
          getState: {
            useQuery: (_input: undefined, options: object) =>
              useQuery(['dressup.getState'], fixture.fetchState, options),
          },
        },
      },
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  fixture.fetchState.mockReset();
});

it('启动未打开账号不查询，进入账号后加载，切号时禁用查询并清空旧装扮', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.fetchState.mockResolvedValue({
    manifest: {
      widgets: [{ itemId: 'widget-a', frameCount: 2, frameTimeMs: 100 }],
      activeWidget: 'widget-a',
      scope: 'all',
      fonts: [],
      bubbles: [],
    },
  });
  function Consumer() {
    const active = useActiveWidget();
    return h('span', null, `${active.widget?.itemId ?? 'none'}:${active.scope}`);
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = (accountOpen: boolean) =>
    act(async () => {
      root.render(
        h(QueryClientProvider, { client }, h(ActiveWidgetProvider, { accountOpen }, h(Consumer))),
      );
    });
  try {
    await render(false);
    expect(fixture.fetchState).not.toHaveBeenCalled();
    expect(host.textContent).toBe('none:mine');

    await render(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fixture.fetchState).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe('widget-a:all');

    await render(false);
    expect(host.textContent).toBe('none:mine');
    await act(async () => {
      await client.invalidateQueries(['dressup.getState']);
    });
    expect(fixture.fetchState).toHaveBeenCalledTimes(1);

    await render(true);
    expect(fixture.fetchState).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    client.clear();
  }
});
