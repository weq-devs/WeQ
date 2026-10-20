import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QQConversationControls } from '../src/renderer/src/components/QQConversationControls';
import { QQGroupMemberControls } from '../src/renderer/src/components/QQGroupMemberControls';
import { QQGroupMemberEditor } from '../src/renderer/src/components/QQGroupMemberControls';

const state = vi.hoisted(() => ({
  role: null as 'owner' | 'admin' | 'member' | null,
  mutate: vi.fn(async (_input: unknown) => ({ state: 'accepted' as const })),
  readTitle: '原头衔',
  readbackResults: [] as boolean[],
  refetch: vi.fn(async () => undefined),
}));
vi.mock('../src/renderer/src/components/qq-actions/GroupActions', () => ({
  GroupActions: () => null,
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({ useDialog: () => vi.fn() }));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    available: true,
    busy: false,
    result: null,
    run: async (
      action: (binding: object) => Promise<unknown>,
      refresh?: () => Promise<unknown>,
      options?: { readback?: () => Promise<boolean> },
    ) => {
      await action({ expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' });
      if (options?.readback) state.readbackResults.push(await options.readback());
      await refresh?.();
      return true;
    },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      listCategories: { useQuery: () => ({}) },
      pickSendFile: { useMutation: () => ({}) },
      qqWrite: {
        groupPolicyState: {
          useQuery: () => ({ data: { policy: 1, rawPolicy: 1 }, isFetching: false }),
        },
        peerState: {
          useQuery: () => ({
            data: {
              role: state.role,
              selfUid: 'u_self',
              selfTitle: '原头衔',
              selfCard: '',
              remark: '',
              pinned: false,
              groupName: '测试群',
              notifyLevel: 1,
            },
            refetch: async () => {
              await state.refetch();
              return { data: { selfTitle: state.readTitle }, error: null };
            },
          }),
        },
        memberState: {
          useQuery: () => ({
            data: { role: state.role, card: '', title: '原头衔' },
            refetch: async () => {
              await state.refetch();
              return { data: { title: state.readTitle }, error: null };
            },
          }),
        },
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
          ].map((name) => [name, { useMutation: () => ({}) }]),
        ),
        groupName: { useMutation: () => ({ mutateAsync: state.mutate }) },
        groupSpecialTitle: { useMutation: () => ({ mutateAsync: state.mutate }) },
      },
    },
  },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.mutate.mockClear();
  state.readTitle = '原头衔';
  state.readbackResults = [];
  state.refetch.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function fixture(element: ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  act(() => root.render(element));
  const details = host.querySelector('details');
  if (details)
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
  return host;
}
describe('专属头衔编辑权限', () => {
  it('独立头衔编辑只展示头衔，沿用现有绑定、目标与写请求', async () => {
    state.role = 'owner';
    const host = fixture(
      h(QQGroupMemberEditor, { groupCode: '123', uid: 'u_peer', field: 'title' }),
    );
    expect(host.querySelector('[aria-label="群名片"]')).toBeNull();
    const input = host.querySelector<HTMLInputElement>('[aria-label="专属头衔"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '新头衔',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="保存专属头衔"]')!.click(),
    );
    expect(state.mutate).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      groupId: 123,
      targetUid: 'u_peer',
      title: '新头衔',
    });
    expect(state.refetch).toHaveBeenCalledOnce();
    expect(state.readbackResults).toEqual([false]);
  });
  it.each(['', '新头衔'])('自己的头衔保存 %s 后按实际内容核对读回', async (title) => {
    state.role = 'owner';
    state.readTitle = title;
    const host = fixture(h(QQConversationControls, { kind: 'group', conv: '123' }));
    const input = host.querySelector<HTMLInputElement>('[aria-label="我的专属头衔"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, title);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="保存我的专属头衔"]')!.click(),
    );
    expect(state.readbackResults).toEqual([true]);
    expect(state.mutate).toHaveBeenCalledOnce();
  });
  it('群名与群头像只在群管理页，保存群名复用原绑定与请求', async () => {
    state.role = 'owner';
    const preferences = fixture(h(QQConversationControls, { kind: 'group', conv: '123' }));
    expect(preferences.querySelector('[aria-label="群名称"]')).toBeNull();
    expect(preferences.textContent).not.toContain('更换群头像');
    expect(preferences.querySelector('[aria-label="我在本群的昵称"]')).not.toBeNull();
    const management = fixture(
      h(QQConversationControls, { kind: 'group', conv: '123', section: 'group-management' }),
    );
    expect(management.querySelector('[aria-label="群备注"]')).toBeNull();
    expect(management.querySelector('[aria-label="我在本群的昵称"]')).toBeNull();
    expect(management.textContent).toContain('更换群头像');
    const name = management.querySelector<HTMLInputElement>('[aria-label="群名称"]')!;
    expect(name.value).toBe('测试群');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        name,
        '新群名称',
      );
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      management.querySelector<HTMLButtonElement>('[aria-label="保存群名称"]')!.click(),
    );
    expect(state.mutate).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      groupId: 123,
      name: '新群名称',
    });
  });
  for (const member of [true, false]) {
    it.each(['owner', 'admin', 'member', null] as const)(
      `${member ? '成员名片' : '会话设置'}：%s`,
      (role) => {
        state.role = role;
        const host = fixture(
          member
            ? h(QQGroupMemberControls, { groupCode: '123', uid: 'u_peer' })
            : h(QQConversationControls, { kind: 'group', conv: '123' }),
        );
        const label = member ? '专属头衔' : '我的专属头衔';
        expect(host.querySelector(`input[aria-label="${label}"]`) !== null).toBe(role === 'owner');
        expect(host.querySelector(`button[aria-label="保存${label}"]`) !== null).toBe(
          role === 'owner',
        );
        if (role !== 'owner') expect(host.textContent).toContain('原头衔');
        else
          expect(host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.value).toBe(
            '原头衔',
          );
      },
    );
  }
});
