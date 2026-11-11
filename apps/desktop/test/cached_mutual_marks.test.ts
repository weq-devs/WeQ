import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  MutualMarkDialog,
  usableCachedMarks,
} from '../src/renderer/src/components/MutualMarkDialog';
import { useViewState } from '../src/renderer/src/state/view';

const state = vi.hoisted(() => ({
  query: {
    data: undefined as unknown,
    isLoading: true,
    isSuccess: false,
    error: null as { message: string } | null,
  },
  account: '99999',
  calls: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: {
        useQuery: () => ({ data: { uin: state.account, configId: `config-${state.account}` } }),
      },
      mutualMark: {
        get: {
          useQuery: (input: unknown) => {
            state.calls(input);
            return state.query;
          },
        },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/RetainedTabs', () => ({ useTabActive: () => true }));
vi.mock('../src/renderer/src/components/MutualMarkLevelDialog', () => ({
  MutualMarkLevelDialog: () => null,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  state.calls.mockClear();
});

it('本地首屏、在线空结果、失败回退及联系人和账号切换不串用标识', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useViewState.setState({ openedUin: '99999' });
  state.account = '99999';
  state.query = { data: undefined, isLoading: true, isSuccess: false, error: null };
  const host = document.createElement('div'),
    root = createRoot(host);
  const render = (uin = '10001', id = 7) =>
    act(() =>
      root.render(
        h(MutualMarkDialog, {
          uin,
          name: '合成联系人',
          embedded: true,
          cachedMarks: [{ type: 'fire', markId: id, iconUrl: 'https://example.test/missing.png' }],
          onClose: () => {},
        }),
      ),
    );
  try {
    render();
    expect(host.textContent).toContain('互动标识 7');
    expect(host.textContent).not.toContain('未点亮');
    expect(host.textContent).not.toContain('Lv.');
    act(() => host.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('svg')).not.toBeNull();
    state.query = {
      data: { categories: [], totalNum: 0 },
      isSuccess: true,
      isLoading: false,
      error: null,
    };
    render();
    expect(host.textContent).not.toContain('互动标识 7');
    state.query = {
      data: undefined,
      isSuccess: false,
      isLoading: false,
      error: { message: '离线' },
    };
    render();
    expect(host.textContent).toContain('互动标识 7');
    expect(host.textContent).toContain('在线更新失败');
    render('10002', 8);
    expect(host.textContent).toContain('互动标识 8');
    expect(host.textContent).not.toContain('互动标识 7');
    act(() => {
      state.account = '88888';
      useViewState.setState({ openedUin: '88888' });
    });
    render('10002', 9);
    expect(state.calls).toHaveBeenLastCalledWith({
      uin: '10002',
      expectedAccountUin: '88888',
      expectedAccountConfigId: 'config-88888',
    });
    expect(host.textContent).not.toContain('互动标识 8');
    expect(host.textContent).toContain('互动标识 9');
  } finally {
    act(() => root.unmount());
  }
});

it('只有真实种类依据的缓存才展示，同类去重且不把图标 URL 当标识', () => {
  expect(
    usableCachedMarks([
      {},
      { iconUrl: 'https://example.test/only.png' },
      { type: 'fire', markId: 7 },
      { type: 'fire', markId: 7 },
      { markId: 8 },
      { type: ' ' },
    ]),
  ).toEqual([{ type: 'fire', markId: 7 }, { markId: 8 }]);
});
