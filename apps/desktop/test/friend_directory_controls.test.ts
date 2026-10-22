import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  FriendDirectoryControls,
  useFriendDirectory,
} from '../src/renderer/src/components/FriendDirectoryControls';

const state = vi.hoisted(() => ({
  mutate: vi.fn(async (_input: unknown) => ({ state: 'confirmed' })),
  refetch: vi.fn(async () => ({})),
  error: null as Error | null,
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source' },
    available: true,
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({
      account: {
        listCategories: { invalidate: async () => {} },
        listBuddies: { invalidate: async () => {} },
      },
    }),
    account: {
      qqWrite: {
        friendRoster: {
          useQuery: () => ({
            data: {
              categories: [
                { id: 0, name: '默认', buddyCount: 0, sortOrder: 0 },
                { id: 5, name: '同学', buddyCount: 0, sortOrder: 1 },
                { id: 9, name: '朋友', buddyCount: 0, sortOrder: 2 },
              ],
              friends: [],
            },
            error: state.error,
            refetch: state.refetch,
          }),
        },
        friendCategories: { useMutation: () => ({ mutateAsync: state.mutate }) },
      },
    },
  },
}));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.error = null;
  state.mutate.mockClear();
  state.refetch.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  [0, 5, [5, 0, 9]],
  [9, 5, [0, 9, 5]],
  [0, 'last', [5, 9, 0]],
  [9, 'first', [9, 0, 5]],
] as const)('分组 %s 移到 %s，双向拖拽都改变顺序', async (source, target, ids) => {
  function Controls() {
    const directory = useFriendDirectory();
    return h('button', { onClick: () => directory?.sort(source, target) }, '排序');
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(h(FriendDirectoryControls, null, h(Controls))));
    await act(async () => host.querySelector('button')!.click());
    expect(state.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ operation: { type: 'sort', ids } }),
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('云端分组读取失败时保留原因和重试，不静默禁用管理入口', async () => {
  state.error = new Error('合成分组读取失败');
  function Controls() {
    const directory = useFriendDirectory();
    return h(
      'button',
      { onClick: directory?.retry, 'data-available': directory?.available },
      directory?.error,
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(h(FriendDirectoryControls, null, h(Controls))));
    const button = host.querySelector('button')!;
    expect(button.textContent).toBe(state.error.message);
    expect(button.dataset.available).toBe('false');
    await act(async () => button.click());
    expect(state.refetch).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
