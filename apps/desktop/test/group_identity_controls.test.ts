import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GroupIdentitySnapshot } from '@weq/protocol';
import { GroupIdentityControls } from '../src/renderer/src/components/GroupIdentityControls';
import type { useQQWriteSession } from '../src/renderer/src/hooks/useQQWriteSession';

const mock = vi.hoisted(() => ({
  data: undefined as GroupIdentitySnapshot | undefined,
  readback: undefined as GroupIdentitySnapshot | undefined,
  error: null as Error | null,
  fetching: false,
  query: vi.fn(),
  refetch: vi.fn(),
  mutate: vi.fn(async (_input: unknown) => ({ state: 'accepted' as const })),
  matches: [] as boolean[],
}));
vi.mock('../src/renderer/src/hooks/useQQAutoRefresh', () => ({
  useQQAutoRefresh: () => ({ enabled: true }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      qqWrite: {
        groupIdentityState: {
          useQuery: (input: unknown, options: unknown) => {
            mock.query(input, options);
            return {
              data: mock.data,
              error: mock.error,
              isFetching: mock.fetching,
              refetch: mock.refetch,
            };
          },
        },
        groupIdentity: { useMutation: () => ({ mutateAsync: mock.mutate }) },
      },
    },
  },
}));

function catalog(selected = '0'): GroupIdentitySnapshot {
  return {
    groupId: 123,
    memberUin: '10001',
    level: { value: 0, name: '等级段', progress: null },
    selectedTitleId: selected,
    selectionKnown: true,
    titles: ['0', '7'].map((id) => ({
      id,
      settableId: Number(id),
      name: id === '0' ? '云端选项甲' : '云端选项乙',
      selected: id === selected,
      specValue: null,
      popText: '',
    })),
  };
}
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mock.data = catalog();
  mock.readback = catalog('7');
  mock.error = null;
  mock.fetching = false;
  mock.matches = [];
  mock.query.mockReset();
  mock.mutate.mockReset().mockResolvedValue({ state: 'accepted' });
  mock.refetch
    .mockReset()
    .mockImplementation(async () => ({ data: mock.readback, error: mock.error }));
});
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.unstubAllGlobals();
});

function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const session: ReturnType<typeof useQQWriteSession> = {
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    available: true,
    busy: false,
    result: null,
    run: async (action, _refresh, options) => {
      await action(session.binding!);
      const matches = (await options?.readback?.()) ?? false;
      mock.matches.push(matches);
      return matches;
    },
  };
  const render = (groupId = 123) =>
    act(() => root.render(h(GroupIdentityControls, { groupId, session, disabled: false })));
  render();
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return {
    host,
    render,
    session,
    select: () => host.querySelector<HTMLSelectElement>('[aria-label="展示头衔"]')!,
    save: () => host.querySelector<HTMLButtonElement>('[aria-label="保存展示头衔"]')!,
  };
}
it('服务端名称与选择原样展示，等级0不丢失，当前值未变化仍可保存', () => {
  const f = fixture();
  expect(f.select().value).toBe('0');
  expect(f.select().selectedOptions[0]!.textContent).toBe('云端选项甲');
  expect(f.host.textContent).toContain('Lv0 · 等级段');
  expect(f.save().disabled).toBe(false);
  expect(mock.query).toHaveBeenCalledWith(
    { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a', groupId: 123 },
    expect.objectContaining({ retry: false, refetchOnWindowFocus: false }),
  );
});
it.each([true, false])('独立提交与云端读回相符=%s，保留账号和群绑定', async (matches) => {
  mock.readback = catalog(matches ? '7' : '0');
  const f = fixture();
  act(() => {
    f.select().value = '7';
    f.select().dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => f.save().click());
  expect(mock.mutate).toHaveBeenCalledOnce();
  expect(mock.mutate).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    groupId: 123,
    titleId: 7,
  });
  expect(mock.refetch).toHaveBeenCalledOnce();
  expect(mock.matches).toEqual([matches]);
});
it('不能以本机已有专属文本替代缺失的选中标记或默认选中第一项', () => {
  mock.data = { ...catalog(), selectedTitleId: null, selectionKnown: false };
  const f = fixture();
  expect(f.select().value).toBe('');
  expect(f.save().disabled).toBe(true);
  expect(f.host.textContent).toContain('未返回明确选中状态');
});
it('读取错误不回落到旧目录，并提供手动重试', async () => {
  mock.error = new Error('OIDB error 319: rule type not match appid');
  const f = fixture();
  expect(f.select().value).toBe('');
  expect(f.select().disabled).toBe(true);
  expect(f.host.querySelector('[role="alert"]')!.textContent).toContain(
    'rule type not match appid',
  );
  await act(async () =>
    f.host.querySelector<HTMLButtonElement>('[aria-label="重试读取展示头衔"]')!.click(),
  );
  expect(mock.refetch).toHaveBeenCalledOnce();
  expect(mock.mutate).not.toHaveBeenCalled();
});
it('读取在途时不可提交旧目录', () => {
  mock.fetching = true;
  const f = fixture();
  expect(f.save().disabled).toBe(true);
  expect(f.host.textContent).toContain('正在读取');
});
it('服务端返回不可转换编号时保留当前名称，不能截断提交', () => {
  mock.data = {
    ...catalog(),
    selectedTitleId: '4294967296',
    titles: [
      {
        id: '4294967296',
        name: '特殊编号头衔',
        selected: true,
        settableId: null,
        specValue: null,
        popText: '',
      },
    ],
  };
  const f = fixture();
  expect(f.host.textContent).toContain('当前展示：特殊编号头衔');
  expect(f.save().disabled).toBe(true);
});
it('同号换数据源或切群后不带入之前未保存的选择', () => {
  const f = fixture();
  act(() => {
    f.select().value = '7';
    f.select().dispatchEvent(new Event('change', { bubbles: true }));
  });
  f.session.binding!.expectedAccountConfigId = 'source-b';
  f.render();
  expect(f.select().value).toBe('0');
  act(() => {
    f.select().value = '7';
    f.select().dispatchEvent(new Event('change', { bubbles: true }));
  });
  f.render(456);
  expect(f.select().value).toBe('0');
});
