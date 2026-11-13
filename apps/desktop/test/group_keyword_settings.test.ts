import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GroupKeywordEditor } from '../src/renderer/src/components/GroupKeywordEditor';

const state = vi.hoisted(() => ({
  save: vi.fn(async (_input: unknown) => {}),
  search: vi.fn(async (_input: unknown) => ({
    members: [{ uid: 'u_target', uin: '10002', card: '目标群成员', nick: '', adminFlag: 0 }],
    total: 1,
  })),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: {
      getGroupKeywordRules: {
        query: async () => ({ '22222': { keywords: [{ keyword: '日程', memberUids: [] }] } }),
      },
      setGroupKeywordRules: { mutate: (input: unknown) => state.save(input) },
    },
    account: { searchGroupMembers: { query: (input: unknown) => state.search(input) } },
  },
}));
vi.mock('../src/renderer/src/lib/clientPreferences', () => ({
  accountBinding: () => ({ expectedAccountUin: '99999', expectedAccountConfigId: 'target-source' }),
}));
vi.mock('../src/renderer/src/hooks/useGroupProfile', () => ({
  previewMemberView: (row: { card: string }) => ({ displayName: row.card, role: 'member' }),
}));
vi.mock('../src/renderer/src/components/ProfileAvatar', () => ({
  ProfileAvatar: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../src/renderer/src/im-template/template/primitives', () => ({ Avatar: () => null }));
vi.mock('../src/renderer/src/hooks/useMultiSelection', () => ({
  useMultiSelection: ({
    onChange,
    selected,
  }: {
    onChange: (selected: Set<string>) => void;
    selected: Set<string>;
  }) => ({
    rootProps: {},
    itemProps: (uid: string) => ({ onClick: () => onChange(new Set([...selected, uid])) }),
  }),
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.save.mockReset().mockResolvedValue(undefined);
  state.search.mockClear();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSaveState = vi.fn();
  await act(async () =>
    root.render(
      h(
        QueryClientProvider,
        { client: cache },
        h(GroupKeywordEditor, { groupId: '22222', members: [], onSaveState }),
      ),
    ),
  );
  let mounted = true;
  const unmount = () => {
    if (mounted) {
      mounted = false;
      act(() => root.unmount());
    }
  };
  cleanups.push(() => {
    unmount();
    cache.clear();
    host.remove();
  });
  return { host, unmount, onSaveState };
}
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
it('未展开成员范围时不加载全群，搜索只读取目标群及其数据源', async () => {
  const { host } = await mount();
  expect(state.search).not.toHaveBeenCalled();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('.group-keyword-item-scope')!.click(),
  );
  await act(async () =>
    type(host.querySelector<HTMLInputElement>('.group-keyword-search input')!, '目标'),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(state.search).toHaveBeenCalledWith(
    expect.objectContaining({
      groupCode: '22222',
      keyword: '目标',
      expectedAccountConfigId: 'target-source',
      offset: 0,
    }),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(host.textContent).toContain('目标群成员');
});
it('保存失败保留草稿，显示失败并能重试同一内容', async () => {
  vi.useFakeTimers();
  state.save.mockRejectedValueOnce(new Error('合成写入失败'));
  const { host, onSaveState } = await mount();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('.group-keyword-item-remove')!.click(),
  );
  await act(async () => vi.advanceTimersByTimeAsync(450));
  expect(host.textContent).toContain('保存失败');
  expect(onSaveState).toHaveBeenLastCalledWith(
    expect.objectContaining({ saving: false, error: expect.stringContaining('合成写入失败') }),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="重试关键词保存或读取"]')!.click(),
  );
  expect(state.save).toHaveBeenCalledTimes(2);
  expect(state.save.mock.calls[0][0]).toEqual(state.save.mock.calls[1][0]);
  expect(host.textContent).not.toContain('合成写入失败');
});
it('关闭前纳入未回车关键词并立即保存', async () => {
  const { host, unmount } = await mount();
  await act(async () =>
    type(host.querySelector<HTMLInputElement>('.group-keyword-input')!, '临时通知'),
  );
  unmount();
  expect(state.save).toHaveBeenCalledWith(
    expect.objectContaining({
      groupId: '22222',
      rules: expect.objectContaining({
        '22222': {
          keywords: [
            { keyword: '日程', memberUids: [] },
            { keyword: '临时通知', memberUids: [] },
          ],
        },
      }),
    }),
  );
});
it('保存串行执行，在途修改不会被先返回的旧内容覆盖', async () => {
  vi.useFakeTimers();
  let resolveSave: () => void = () => {};
  state.save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const { host } = await mount();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('.group-keyword-item-remove')!.click(),
  );
  await act(async () => vi.advanceTimersByTimeAsync(450));
  const input = host.querySelector<HTMLInputElement>('.group-keyword-input')!;
  await act(async () => {
    type(input, '新词');
  });
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  await act(async () => vi.advanceTimersByTimeAsync(450));
  expect(state.save).toHaveBeenCalledTimes(1);
  await act(async () => resolveSave());
  expect(state.save).toHaveBeenCalledTimes(2);
  expect(state.save.mock.calls[1][0]).toMatchObject({
    rules: { '22222': { keywords: [{ keyword: '新词', memberUids: [] }] } },
  });
});
