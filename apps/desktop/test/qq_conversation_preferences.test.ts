import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QQConversationControls } from '../src/renderer/src/components/QQConversationControls';
import type { QQWriteBinding, QQWriteOutcome } from '../src/renderer/src/hooks/useQQWriteSession';

const mock = vi.hoisted(() => ({
  configId: 'source-a',
  notifyLevel: 1 as number | null,
  friendDisturb: null as boolean | null,
  cachedDisturb: null as boolean | null,
  disturbError: null as Error | null,
  disturbFetching: false,
  readFriendDisturb: null as boolean | null,
  readPinned: false,
  pinned: false,
  serverPolicy: 1 as number | null,
  mutate: vi.fn(async (_input: unknown): Promise<QQWriteOutcome> => ({ state: 'accepted' })),
  refetch: vi.fn(async () => {}),
  refetchPolicy: vi.fn(async () => {}),
  refetchDisturb: vi.fn(async () => {}),
  refetchCategories: vi.fn(async () => {}),
  refetchCloudRoster: vi.fn(async () => {}),
  readCategory: 0,
  readbacks: [] as boolean[],
  successTexts: [] as string[],
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
      options?: { readback?: () => Promise<boolean>; readbackSuccessText?: string },
    ) => {
      await action({ expectedAccountUin: '10001', expectedAccountConfigId: mock.configId });
      if (options?.readback) mock.readbacks.push(await options.readback());
      if (options?.readbackSuccessText) mock.successTexts.push(options.readbackSuccessText);
      await refresh?.();
      return true;
    },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ account: { specialCare: { invalidate: async () => {} } } }),
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
        friendRoster: {
          useQuery: () => ({
            data: {
              friends: [{ uid: 'u_friend', categoryId: 0 }],
              categories: [{ id: 5, name: '测试分组' }],
            },
            refetch: async () => {
              await mock.refetchCloudRoster();
              return { data: { friends: [{ uid: 'u_friend', categoryId: mock.readCategory }] } };
            },
          }),
        },
        friendRemarkState: {
          useQuery: () => ({
            data: { uid: 'u_peer', remark: '' },
            refetch: async () => ({ data: { uid: 'u_peer', remark: '' } }),
          }),
        },
        friendSpecialCareState: { useQuery: () => ({ data: undefined }) },
        friendSpecialCare: { useMutation: () => ({}) },
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
              friendDisturb: mock.cachedDisturb,
              friend: true,
              remark: '',
              pinned: mock.pinned,
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
                data: {
                  friend: true,
                  notifyLevel: mock.notifyLevel,
                  categoryId: mock.readCategory,
                  friendDisturb: mock.readFriendDisturb,
                  pinned: mock.readPinned,
                },
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
        friendDisturbState: {
          useQuery: () => ({
            data: { uid: 'u_friend', enabled: mock.friendDisturb, source: 'qq-server' },
            error: mock.disturbError,
            isFetching: mock.disturbFetching,
            refetch: async () => {
              await mock.refetchDisturb();
              return {
                data: { uid: 'u_friend', enabled: mock.readFriendDisturb },
                error: mock.disturbError,
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
  mock.friendDisturb = null;
  mock.cachedDisturb = null;
  mock.disturbError = null;
  mock.disturbFetching = false;
  mock.readFriendDisturb = null;
  mock.readPinned = false;
  mock.pinned = false;
  mock.serverPolicy = 1;
  mock.mutate.mockReset().mockResolvedValue({ state: 'accepted' });
  mock.refetch.mockReset().mockResolvedValue(undefined);
  mock.refetchPolicy.mockReset().mockResolvedValue(undefined);
  mock.refetchDisturb.mockReset().mockResolvedValue(undefined);
  mock.refetchCategories.mockReset().mockResolvedValue(undefined);
  mock.refetchCloudRoster.mockReset().mockResolvedValue(undefined);
  mock.readCategory = 0;
  mock.readbacks = [];
  mock.successTexts = [];
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

it.each([true, false])('云端免打扰值 %s 优先于本机缓存，并随读取更新', (enabled) => {
  mock.friendDisturb = enabled;
  mock.cachedDisturb = !enabled;
  const host = fixture('c2c');
  expect(host.querySelector('[aria-label="消息免打扰"]')!.getAttribute('aria-checked')).toBe(
    String(enabled),
  );
  mock.friendDisturb = !enabled;
  host.render();
  expect(host.querySelector('[aria-label="消息免打扰"]')!.getAttribute('aria-checked')).toBe(
    String(!enabled),
  );
});

it.each([true, false, null])('免打扰只提交一次并核对实际云端读回 %s', async (readback) => {
  mock.friendDisturb = false;
  mock.readFriendDisturb = readback;
  mock.mutate.mockResolvedValue({ state: 'unconfirmed' });
  const host = fixture('c2c');
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="消息免打扰"]')!.click(),
  );
  expect(mock.mutate).toHaveBeenCalledOnce();
  expect(mock.mutate).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    uid: 'u_friend',
    enabled: true,
  });
  expect(mock.readbacks).toEqual([readback === true]);
  expect(mock.refetch).toHaveBeenCalledTimes(1);
  expect(mock.refetchDisturb).toHaveBeenCalledOnce();
});

it.each(['置顶会话', '消息免打扰'])('%s 共用提交、状态核对和刷新行为', async (label) => {
  mock.friendDisturb = false;
  mock.readFriendDisturb = true;
  mock.readPinned = true;
  const host = fixture('c2c');
  const toggle = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  expect(toggle.getAttribute('role')).toBe('switch');
  expect(toggle.className).toBe('weq-set-toggle');
  expect(host.querySelector(`[aria-label="保存${label}"]`)).toBeNull();
  await act(async () => toggle.click());
  expect(mock.mutate).toHaveBeenCalledOnce();
  expect(mock.readbacks).toEqual([true]);
  expect(mock.refetch).toHaveBeenCalledTimes(label === '置顶会话' ? 2 : 1);
});

it('云端读取失败不显示本机关闭或旧在线缓存，提供重试', async () => {
  mock.cachedDisturb = false;
  mock.friendDisturb = true;
  mock.disturbError = new Error('测试读取失败');
  const host = fixture('c2c');
  const toggle = host.querySelector<HTMLButtonElement>('[aria-label="消息免打扰"]')!;
  expect(toggle.getAttribute('aria-checked')).toBe('mixed');
  expect(toggle.disabled).toBe(true);
  expect(host.textContent).toContain('免打扰状态读取失败：测试读取失败');
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="重试读取 QQ 会话设置"]')!.click(),
  );
  expect(mock.refetchDisturb).toHaveBeenCalledOnce();
});

it('云端查询在途时不允许用旧值反向切换', () => {
  mock.friendDisturb = false;
  mock.disturbFetching = true;
  const host = fixture('c2c');
  expect(host.querySelector<HTMLButtonElement>('[aria-label="消息免打扰"]')!.disabled).toBe(true);
});

it.each([
  { label: '置顶会话', initial: false, expected: '已置顶' },
  { label: '置顶会话', initial: true, expected: '已取消置顶' },
  { label: '消息免打扰', initial: false, expected: '已开启免打扰' },
  { label: '消息免打扰', initial: true, expected: '已关闭免打扰' },
])('$label 从 $initial 切换后用具体结果作为成功横幅文案', async ({ label, initial, expected }) => {
  mock.pinned = initial;
  mock.friendDisturb = initial;
  mock.readPinned = !initial;
  mock.readFriendDisturb = !initial;
  const host = fixture('c2c');
  await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  expect(mock.successTexts).toEqual([expected]);
  expect(mock.readbacks).toEqual([true]);
  expect(host.textContent).not.toContain(expected);
});

it.each([0, 5])('选择已有分组即提交并核对实际读回 %s，不将受理当作同步', async (readCategory) => {
  mock.readCategory = readCategory;
  const host = fixture('c2c');
  const select = host.querySelector<HTMLSelectElement>('[aria-label="好友分组"]')!;
  await act(async () => {
    select.value = '5';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.querySelector('[aria-label="保存好友分组"]')).toBeNull();
  expect(mock.mutate).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    uid: 'u_friend',
    categoryId: 5,
  });
  expect(mock.readbacks).toEqual([readCategory === 5]);
  expect(mock.refetchCategories).toHaveBeenCalledOnce();
  expect(mock.refetchCloudRoster).toHaveBeenCalledTimes(2);
});
