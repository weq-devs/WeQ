import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FavoriteBundleImport } from '../src/renderer/src/components/qq-actions/FavoriteBundleImport';

const state = vi.hoisted(() => ({
  error: null as Error | null,
  refetch: vi.fn(async () => ({ error: null })),
  changed: vi.fn(async () => {}),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {},
  trpc: {
    useUtils: () => ({}),
    account: {
      qqActions: {
        favoriteImportState: {
          useQuery: () => ({
            data: { token: 'synthetic-import', phase: 'ready', items: [] },
            error: state.error,
            isFetching: false,
            refetch: state.refetch,
          }),
        },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: () => vi.fn(),
  Modal: ({ children }: { children: ReactNode }) => h('div', null, children),
}));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  ActionIcon: ({
    label,
    disabled,
    onClick,
    children,
  }: {
    label: string;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
  }) => h('button', { 'aria-label': label, disabled, onClick }, children),
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  state.error = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  cleanups.push(() => act(() => root.unmount()));
  await act(async () =>
    root.render(
      h(FavoriteBundleImport, {
        binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
        available: true,
        onBusyChange: vi.fn(),
        onChanged: state.changed,
      }),
    ),
  );
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="导入收藏表情包"]')!.click());
  return host;
}
it('正常导入预览没有常驻刷新或重新核对按钮', async () => {
  const host = await fixture();
  expect(host.querySelector('[aria-label="重新读取导入状态"]')).toBeNull();
  expect(host.querySelector('[aria-label="重新核对导入状态"]')).toBeNull();
});
it('读取失败可核对导入状态与收藏列表，不重发上传', async () => {
  state.error = new Error('合成读取失败');
  const host = await fixture();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="重新核对导入状态"]')!.click(),
  );
  expect(state.refetch).toHaveBeenCalledOnce();
  expect(state.changed).toHaveBeenCalledOnce();
});
