import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QQConversationControls } from '../src/renderer/src/components/QQConversationControls';
import type { QQWriteBinding, QQWriteOutcome } from '../src/renderer/src/hooks/useQQWriteSession';

const mock = vi.hoisted(() => ({
  configId: 'source-a',
  notifyLevel: 1 as number | null,
  serverPolicy: 1 as number | null,
  mutate: vi.fn(async (_input: unknown): Promise<QQWriteOutcome> => ({ state: 'accepted' })),
  refetch: vi.fn(async () => {}),
  refetchPolicy: vi.fn(async () => {}),
  refetchCategories: vi.fn(async () => {}),
  readCategory: 0,
  readbacks: [] as boolean[],
}));
vi.mock('../src/renderer/src/components/qq-actions/GroupActions', () => ({
  GroupActions: () => null,
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: (selector: (state: { confirm: () => Promise<boolean> }) => unknown) =>
    selector({ confirm: async () => true }),
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: mock.configId },
    available: true,
    busy: false,
    result: null,
    run: async (
      action: (binding: QQWriteBinding) => Promise<QQWriteOutcome>,
      refresh?: () => Promise<unknown>,
      options?: { readback?: () => Promise<boolean> },
    ) => {
      await action({ expectedAccountUin: '10001', expectedAccountConfigId: mock.configId });
      if (options?.readback) mock.readbacks.push(await options.readback());
      await refresh?.();
      return true;
    },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      listCategories: {
        useQuery: () => ({
          data: [{ id: 5, name: '测试分组' }],
          refetch: async () => {
            await mock.refetchCategories();
            return { error: null };
          },
        }),
      },
      pickSendFile: { useMutation: () => ({ mutateAsync: async () => null }) },
      qqWrite: {
        ...Object.fromEntries(
          [
            'friendRemark',
            'groupRemark',
            'pin',
            'friendDisturb',
            'groupMessagePolicy',
            'friendCategory',
            'groupName',
            'groupMemberCard',
            'groupSpecialTitle',
            'groupAvatar',
          ].map((name) => [name, { useMutation: () => ({ mutateAsync: mock.mutate }) }]),
        ),
        peerState: {
          useQuery: () => ({
            data: {
              notifyLevel: mock.notifyLevel,
              friend: true,
              remark: '',
              pinned: false,
              categoryId: 0,
              selfCard: '',
              selfTitle: '',
              selfUid: 'u_self',
              role: 'member',
            },
            isFetching: false,
            refetch: async () => {
              await mock.refetch();
              return {
                data: { notifyLevel: mock.notifyLevel, categoryId: mock.readCategory },
                error: null,
              };
            },
          }),
        },
        groupPolicyState: {
          useQuery: () => ({
            data: {
              policy: mock.serverPolicy === 99 ? null : mock.serverPolicy,
              rawPolicy: mock.serverPolicy,
              source: 'qq-server',
            },
            isFetching: false,
            refetch: async () => {
              await mock.refetchPolicy();
              return {
                data: {
                  policy: mock.serverPolicy === 99 ? null : mock.serverPolicy,
                  rawPolicy: mock.serverPolicy,
                },
                error: null,
              };
            },
          }),
        },
      },
    },
  },
}));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mock.configId = 'source-a';
  mock.notifyLevel = 1;
  mock.serverPolicy = 1;
  mock.mutate.mockReset().mockResolvedValue({ state: 'accepted' });
  mock.refetch.mockReset().mockResolvedValue(undefined);
  mock.refetchPolicy.mockReset().mockResolvedValue(undefined);
  mock.refetchCategories.mockReset().mockResolvedValue(undefined);
  mock.readCategory = 0;
  mock.readbacks = [];
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function fixture(kind: 'c2c' | 'group') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(() =>
      root.render(h(QQConversationControls, { kind, conv: kind === 'group' ? '123' : 'u_friend' })),
    );
  render();
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return Object.assign(host, { render });
}
it('群消息策略保存后自动核对读回，保留群号、策略和账号绑定', async () => {
  const host = fixture('group');
  const select = host.querySelector<HTMLSelectElement>('[aria-label="消息接收"]')!;
  await act(async () => {
    select.value = '4';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.querySelector('[aria-label="保存消息接收"]')).toBeNull();
  expect(mock.mutate).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    groupId: 123,
    policy: 4,
  });
  expect(mock.refetch).toHaveBeenCalledOnce();
  expect(mock.refetchPolicy).toHaveBeenCalledOnce();
});
it('服务端为屏蔽而本机仍为正常提醒时，编辑器显示服务端值并说明缓存未同步', () => {
  mock.serverPolicy = 3;
  const host = fixture('group');
  expect(host.querySelector<HTMLSelectElement>('[aria-label="消息接收"]')!.value).toBe('3');
  expect(host.textContent).toContain('服务端与本机消息策略尚未同步');
});
it('未知服务端策略保留原始编号，不回落为正常提醒', () => {
  mock.serverPolicy = 99;
  const host = fixture('group');
  const select = host.querySelector<HTMLSelectElement>('[aria-label="消息接收"]')!;
  expect(select.value).toBe('99');
  expect(select.selectedOptions[0].textContent).toBe('未识别 (99)');
});
it('同号切换数据源后不保留另一来源的策略请求值', async () => {
  const host = fixture('group');
  const select = host.querySelector<HTMLSelectElement>('[aria-label="消息接收"]')!;
  await act(async () => {
    select.value = '4';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(select.value).toBe('4');
  mock.configId = 'source-b';
  host.render();
  expect(host.querySelector<HTMLSelectElement>('[aria-label="消息接收"]')!.value).toBe('1');
});
it.each([0, 1, 2, 3, 4, 99])('好友提醒级别 %s 不能冒充免打扰的权威开关状态', (level) => {
  mock.notifyLevel = level;
  const host = fixture('c2c');
  expect(host.querySelector('select[aria-label="消息免打扰"]')).toBeNull();
  expect(host.querySelector('[aria-label="消息免打扰"]')!.getAttribute('aria-checked')).toBe(
    'mixed',
  );
});

it.each([0, 5])('移入已有分组保存后核对实际读回 %s，不将受理当作同步', async (readCategory) => {
  mock.readCategory = readCategory;
  const host = fixture('c2c');
  const select = host.querySelector<HTMLSelectElement>('[aria-label="好友分组"]')!;
  act(() => {
    select.value = '5';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="保存好友分组"]')!.click(),
  );
  expect(mock.mutate).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    uid: 'u_friend',
    categoryId: 5,
  });
  expect(mock.readbacks).toEqual([readCategory === 5]);
  expect(mock.refetchCategories).toHaveBeenCalledOnce();
});
