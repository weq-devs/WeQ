import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { useGroupLabelSetter } from '../src/renderer/src/hooks/useGroupLabelSetter';

const state = vi.hoisted(() => ({
  binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
  available: true,
  read: vi.fn(async () => ({ uid: 'u_peer', uin: '10002', nick: '在线昵称' })),
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({ useQQWriteSession: () => state }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { getGroupLabelSetter: { query: state.read } } },
}));
afterEach(() => vi.unstubAllGlobals());

it('浮层挂载后自动补全缺项，按账号数据源缓存，完整本地资料不再查询', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement('div');
  const root = createRoot(host);
  function Fixture({ missing = true }: { missing?: boolean }) {
    const query = useGroupLabelSetter('12345', 'u_peer', missing);
    return h('span', null, query.data?.nick);
  }
  const render = async (missing = true) => {
    await act(async () =>
      root.render(h(QueryClientProvider, { client: cache }, h(Fixture, { missing }))),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  try {
    await render(false);
    expect(state.read).not.toHaveBeenCalled();
    await render();
    expect(state.read).toHaveBeenLastCalledWith({
      ...state.binding,
      groupCode: '12345',
      uid: 'u_peer',
      online: true,
    });
    expect(host.textContent).toBe('在线昵称');
    await render();
    expect(state.read).toHaveBeenCalledTimes(1);
    state.binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-b' };
    state.available = false;
    await render();
    expect(state.read).toHaveBeenLastCalledWith({
      ...state.binding,
      groupCode: '12345',
      uid: 'u_peer',
      online: false,
    });
    state.available = true;
    await render();
    expect(state.read).toHaveBeenLastCalledWith({
      ...state.binding,
      groupCode: '12345',
      uid: 'u_peer',
      online: true,
    });
  } finally {
    act(() => root.unmount());
    cache.clear();
  }
});
