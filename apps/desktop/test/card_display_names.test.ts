import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { cardDisplayNames } from '../src/main/ipc/routers/card_display_names';
import { useCardDisplayNames } from '../src/renderer/src/hooks/useCardDisplayNames';

const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { getCardDisplayNames: { query: mock.query } } },
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    available: true,
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source' },
  }),
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: (select: (state: { openedUin: string }) => unknown) =>
    select({ openedUin: '10001' }),
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

it('云端名称仅更新名片副本，清空备注有效，失败时保留本地值', async () => {
  const local = Object.freeze({ nick: '本地昵称', remark: '本地备注' });
  expect(
    await cardDisplayNames(
      local,
      async () => '云端昵称',
      async () => '',
    ),
  ).toEqual({ nick: '云端昵称', remark: '' });
  expect(
    await cardDisplayNames(
      local,
      async () => {
        throw new Error('离线');
      },
      async () => null,
    ),
  ).toEqual({ nick: local.nick, remark: '' });
  expect(local).toEqual({ nick: '本地昵称', remark: '本地备注' });
});

it('名片首屏显示本地，云端补全后只更新名片，切换目标不接受旧结果', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const finishes: Array<(names: { name: string; remark?: string }) => void> = [];
  mock.query.mockReset().mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
  const host = document.createElement('div');
  const display = createRoot(host);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = (target: string) =>
    display.render(h(QueryClientProvider, { client: cache }, h(Probe, { target })));
  const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  cleanups.push(() => act(() => display.unmount()));
  function Probe({ target }: { target: string }) {
    const cloud = useCardDisplayNames('user', target);
    return h('span', null, cloud?.name ?? '本地昵称');
  }
  act(() => render('20002'));
  expect(host.textContent).toBe('本地昵称');
  await act(async () => {
    finishes[0]({ name: '云端昵称' });
    await flush();
  });
  expect(host.textContent).toBe('云端昵称');
  act(() => render('30003'));
  expect(host.textContent).toBe('本地昵称');
  act(() => render('40004'));
  await act(async () => {
    finishes[1]({ name: '迟到的旧昵称' });
    await flush();
  });
  expect(host.textContent).toBe('本地昵称');
  await act(async () => {
    finishes[2]({ name: '当前云端昵称' });
    await flush();
  });
  expect(host.textContent).toBe('当前云端昵称');
});
