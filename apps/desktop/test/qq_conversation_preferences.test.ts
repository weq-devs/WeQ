import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QQConversationControls } from '../src/renderer/src/components/QQConversationControls';
import type { QQWriteBinding, QQWriteOutcome } from '../src/renderer/src/hooks/useQQWriteSession';

const mock = vi.hoisted(() => ({
  notifyLevel: 1 as number | null,
  mutate: vi.fn(async (_input: unknown): Promise<QQWriteOutcome> => ({ state: 'accepted' })),
  refetch: vi.fn(async () => {}),
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
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    available: true,
    busy: false,
    result: null,
    run: async (
      action: (binding: QQWriteBinding) => Promise<QQWriteOutcome>,
      refresh?: () => Promise<unknown>,
      options?: { readback?: () => Promise<boolean> },
    ) => {
      await action({ expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' });
      await options?.readback?.();
      await refresh?.();
      return true;
    },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      listCategories: { useQuery: () => ({ data: [] }) },
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
              return { data: { notifyLevel: mock.notifyLevel }, error: null };
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
  mock.notifyLevel = 1;
  mock.mutate.mockReset().mockResolvedValue({ state: 'accepted' });
  mock.refetch.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function fixture(kind: 'c2c' | 'group') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(h(QQConversationControls, { kind, conv: kind === 'group' ? '123' : 'u_friend' })),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
it('群消息策略保存后自动核对读回，保留群号、策略和账号绑定', async () => {
  const host = fixture('group');
  const select = host.querySelector<HTMLSelectElement>('[aria-label="消息接收"]')!;
  act(() => {
    select.value = '4';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="保存消息接收"]')!.click(),
  );
  expect(mock.mutate).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    groupId: 123,
    policy: 4,
  });
  expect(mock.refetch).toHaveBeenCalledOnce();
});
it.each([0, 1, 2, 3, 4, 99])('好友提醒级别 %s 不能冒充免打扰的权威开关状态', (level) => {
  mock.notifyLevel = level;
  const host = fixture('c2c');
  expect(host.querySelector<HTMLSelectElement>('[aria-label="消息免打扰"]')!.value).toBe('');
});
