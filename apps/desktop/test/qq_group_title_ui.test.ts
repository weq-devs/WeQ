import { act, cloneElement, isValidElement, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QQConversationControls } from '../src/renderer/src/components/QQConversationControls';
import { QQGroupMemberControls } from '../src/renderer/src/components/QQGroupMemberControls';
import { QQGroupMemberEditor } from '../src/renderer/src/components/QQGroupMemberControls';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const state = vi.hoisted(() => ({
  role: null as 'owner' | 'admin' | 'member' | null,
  targetRole: 'member' as 'owner' | 'admin' | 'member' | null,
  memberUid: 'u_peer',
  available: true,
  mutate: vi.fn(async (_input: unknown) => ({ state: 'accepted' as const })),
  readTitle: '原头衔',
  readCard: '',
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
    available: state.available,
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
    useUtils: () => ({ account: { specialCare: { invalidate: async () => {} } } }),
    account: {
      listCategories: { useQuery: () => ({}) },
      pickSendFile: { useMutation: () => ({}) },
      qqWrite: {
        friendRoster: { useQuery: () => ({ data: undefined }) },
        friendRemarkState: { useQuery: () => ({ data: undefined }) },
        friendSpecialCareState: { useQuery: () => ({ data: undefined }) },
        friendSpecialCare: { useMutation: () => ({}) },
        friendDisturbState: { useQuery: () => ({ data: undefined, isFetching: false }) },
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
            data: {
              uid: state.memberUid,
              role: state.role,
              targetRole: state.targetRole,
              card: '',
              title: '原头衔',
            },
            refetch: async () => {
              await state.refetch();
              return {
                data: {
                  uid: state.memberUid,
                  role: state.role,
                  targetRole: state.targetRole,
                  card: state.readCard,
                  title: state.readTitle,
                },
                error: null,
              };
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
        groupMemberCard: { useMutation: () => ({ mutateAsync: state.mutate }) },
        groupSpecialTitle: { useMutation: () => ({ mutateAsync: state.mutate }) },
      },
    },
  },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.mutate.mockClear();
  state.targetRole = 'member';
  state.memberUid = 'u_peer';
  state.available = true;
  state.readTitle = '原头衔';
  state.readCard = '';
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
  return Object.assign(host, {
    update: () => act(() => root.render(isValidElement(element) ? cloneElement(element) : element)),
  });
}
describe('专属头衔编辑权限', () => {
  it('群设置不再挂载展示头衔选择、云端等级或本机显示开关', () => {
    state.role = 'owner';
    const host = fixture(h(QQConversationControls, { kind: 'group', conv: '123' }));
    for (const label of ['展示头衔', '云端群等级', '显示头衔', '显示等级'])
      expect(host.textContent).not.toContain(label);
    expect(host.querySelector('[aria-label="我的专属头衔"]')).not.toBeNull();
  });
  it.each([true, false])('成员弹窗不继承设置页的大间距，CSS 后加载顺序为 %s', (globalLast) => {
    const feature = readFileSync(resolve('src/renderer/src/styles/group-member-edit.css'), 'utf8');
    const global = '.weq-set { display: grid; gap: 16px; }';
    const style = document.createElement('style');
    style.textContent = globalLast ? feature + global : global + feature;
    document.head.append(style);
    const dialog = document.createElement('section');
    dialog.className = 'group-member-dialog weq-set';
    document.body.append(dialog);
    cleanups.push(() => {
      style.remove();
      dialog.remove();
    });
    expect(Number.parseFloat(getComputedStyle(dialog).gap)).toBe(0);
  });
  for (const role of ['owner', 'admin', 'member'] as const) {
    it.each(['owner', 'admin', 'member'] as const)(
      `${role} 查看 %s 时只显示可编辑字段，不再展开折叠区`,
      (targetRole) => {
        state.role = role;
        state.targetRole = targetRole;
        const host = fixture(h(QQGroupMemberControls, { groupCode: '123', uid: 'u_peer' }));
        expect(host.querySelector('details')).toBeNull();
        expect(Boolean(host.querySelector('input[aria-label="群昵称"]'))).toBe(
          role === 'owner' || (role === 'admin' && targetRole !== 'owner'),
        );
        expect(Boolean(host.querySelector('input[aria-label="专属头衔"]'))).toBe(role === 'owner');
        if (role === 'member' || (role === 'admin' && targetRole === 'owner'))
          expect(host.textContent).not.toContain('群昵称与头衔');
        expect(state.mutate).not.toHaveBeenCalled();
      },
    );
  }
  it('目标身份不一致或管理员未读到目标角色时不暴露编辑入口', () => {
    state.role = 'admin';
    state.targetRole = null;
    const unknown = fixture(h(QQGroupMemberControls, { groupCode: '123', uid: 'u_peer' }));
    expect(unknown.querySelector('input')).toBeNull();
    state.role = 'owner';
    state.memberUid = 'u_other';
    const mismatched = fixture(h(QQGroupMemberControls, { groupCode: '123', uid: 'u_peer' }));
    expect(mismatched.querySelector('input')).toBeNull();
  });
  it('权限变化后移除编辑字段，不提交原草稿', () => {
    state.role = 'owner';
    const host = fixture(h(QQGroupMemberControls, { groupCode: '123', uid: 'u_peer' }));
    const input = host.querySelector<HTMLInputElement>('[aria-label="专属头衔"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '未保存头衔',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    state.role = 'member';
    host.update();
    expect(host.querySelector('input')).toBeNull();
    expect(host.querySelector('button')).toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('离线不伪造权限，有权限的字段保留但不能保存', async () => {
    state.role = 'owner';
    state.available = false;
    const host = fixture(h(QQGroupMemberControls, { groupCode: '123', uid: 'u_peer' }));
    expect(host.querySelector<HTMLInputElement>('[aria-label="群昵称"]')!.disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>('[aria-label="专属头衔"]')!.disabled).toBe(true);
    const save = host.querySelector<HTMLButtonElement>('[aria-label="保存专属头衔"]')!;
    expect(save.disabled).toBe(true);
    await act(async () => save.click());
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('管理员名片保存沿用绑定和目标，保存后核对实际名片读回', async () => {
    state.role = 'admin';
    state.targetRole = 'member';
    state.readCard = '新群昵称';
    const host = fixture(h(QQGroupMemberControls, { groupCode: '123', uid: 'u_peer' }));
    const input = host.querySelector<HTMLInputElement>('[aria-label="群昵称"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        state.readCard,
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="保存群昵称"]')!.click(),
    );
    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(state.mutate).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      groupId: 123,
      targetUid: 'u_peer',
      card: state.readCard,
    });
    expect(state.readbackResults).toEqual([true]);
  });
  it('独立头衔编辑只展示头衔，沿用现有绑定、目标与写请求', async () => {
    state.role = 'owner';
    const host = fixture(
      h(QQGroupMemberEditor, { groupCode: '123', uid: 'u_peer', field: 'title' }),
    );
    expect(host.querySelector('[aria-label="群昵称"]')).toBeNull();
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
        if (role !== 'owner' && !member) expect(host.textContent).toContain('原头衔');
        else if (role !== 'owner') {
          expect(host.textContent).not.toContain('专属头衔');
          expect(Boolean(host.querySelector('input[aria-label="群昵称"]'))).toBe(role === 'admin');
        } else
          expect(host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.value).toBe(
            '原头衔',
          );
      },
    );
  }
});
