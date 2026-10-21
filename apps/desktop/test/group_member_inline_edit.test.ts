import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QQGroupMemberControls } from '../src/renderer/src/components/QQGroupMemberControls';

const rpc = vi.hoisted(() => ({
  role: 'owner',
  targetRole: 'member',
  card: '原名片',
  title: '原头衔',
  run: vi.fn(async (write: (binding: object) => Promise<unknown>) => {
    await write({ expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' });
    return true;
  }),
  cardWrite: vi.fn(async () => ({})),
  titleWrite: vi.fn(async () => ({})),
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    available: true,
    busy: false,
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    result: null,
    run: rpc.run,
  }),
}));
vi.mock('../src/renderer/src/hooks/useQQAutoRefresh', () => ({ useQQAutoRefresh: () => ({}) }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      qqWrite: {
        memberState: {
          useQuery: () => ({
            data: {
              uid: 'u_peer',
              role: rpc.role,
              targetRole: rpc.targetRole,
              card: rpc.card,
              title: rpc.title,
            },
          }),
        },
        groupMemberCard: { useMutation: () => ({ mutateAsync: rpc.cardWrite }) },
        groupSpecialTitle: { useMutation: () => ({ mutateAsync: rpc.titleWrite }) },
      },
    },
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  rpc.role = 'owner';
  rpc.targetRole = 'member';
});

it.each(['群名片', '专属头衔'])(
  '%s 原行展示，点铅笔才进入编辑，取消不写，确认保留账号与目标',
  async (label) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = () =>
      act(() =>
        root.render(
          h(QQGroupMemberControls, {
            groupCode: '123',
            uid: 'u_peer',
            profile: { card: '缓存名片', title: '缓存头衔' },
          }),
        ),
      );
    try {
      render();
      expect(host.querySelector('input')).toBeNull();
      const edit = () =>
        act(() => host.querySelector<HTMLButtonElement>(`[aria-label="编辑${label}"]`)!.click());
      edit();
      act(() => host.querySelector<HTMLButtonElement>(`[aria-label="取消编辑${label}"]`)!.click());
      expect(rpc.run).not.toHaveBeenCalled();
      edit();
      const unchangedSave = host.querySelector<HTMLButtonElement>(`[aria-label="保存${label}"]`)!;
      expect(unchangedSave.disabled).toBe(false);
      await act(async () => unchangedSave.click());
      expect(label === '群名片' ? rpc.cardWrite : rpc.titleWrite).toHaveBeenLastCalledWith(
        expect.objectContaining({
          [label === '群名片' ? 'card' : 'title']: label === '群名片' ? rpc.card : rpc.title,
        }),
      );
      edit();
      const input = host.querySelector('input')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          '更新后的资料',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () =>
        host
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      expect(rpc.run).toHaveBeenCalledTimes(2);
      expect(label === '群名片' ? rpc.cardWrite : rpc.titleWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedAccountUin: '10001',
          expectedAccountConfigId: 'source-a',
          groupId: 123,
          targetUid: 'u_peer',
          [label === '群名片' ? 'card' : 'title']: '更新后的资料',
        }),
      );
      expect(host.querySelector('input')).toBeNull();
      rpc.role = 'member';
      render();
      expect(host.querySelector('[aria-label^="编辑"]')).toBeNull();
      expect(host.textContent).toContain('群名片');
      expect(host.textContent).toContain('专属头衔');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
