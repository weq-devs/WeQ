import { act, createElement as h, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContactNoticeDialog,
  GroupNoticeDialog,
} from '../src/renderer/src/components/ContactNoticeDialogs';
import type {
  ContactRequest,
  GroupJoinRequest,
  User,
} from '../src/renderer/src/im-template/template/types';
import type { NoticeOperation } from '../src/renderer/src/lib/contactNotice';

const state = vi.hoisted(() => ({ operations: [] as NoticeOperation[] }));
vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  withQQAccountScope: <P extends object>(Component: ComponentType<P>) => Component,
}));
vi.mock('../src/renderer/src/components/qq-actions/RequestActions', () => ({
  useNoticeOperations: () => ({ operations: state.operations }),
  RequestActions: () => h('button', { type: 'button', 'aria-label': '同意申请' }, '同意'),
}));

const user: User = {
  id: 'u_applicant',
  username: 'u_applicant',
  identityLabel: 'QQ',
  identityValue: '10002',
  displayName: '申请人',
  avatarUrl: null,
};
const friend: ContactRequest = {
  id: 'friend-a',
  direction: 'incoming',
  status: 'accepted',
  user,
  createdAt: '2026-10-19T01:00:00Z',
  respondedAt: null,
  message: '你好',
};
const group: GroupJoinRequest = {
  id: 'group-a',
  user,
  action: '申请加入',
  handleState: 'pending',
  createdAt: friend.createdAt,
  respondedAt: null,
  operator: null,
  systemRemark: null,
  message: '你好',
  group: {
    id: '123',
    conversationId: '123',
    identityLabel: 'Group',
    identityValue: '123',
    name: '通知所属群',
    avatarUrl: null,
    announcement: null,
    memberCount: 2,
  },
};
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.operations = [];
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture(element: ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
function click(host: HTMLElement, detail = 1) {
  const button = host.querySelector<HTMLButtonElement>('[aria-label="查看 申请人 的名片"]')!;
  act(() =>
    button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail, clientX: 42, clientY: 64 }),
    ),
  );
  return button;
}

describe('通知头像名片入口', () => {
  it.each([ContactNoticeDialog, GroupNoticeDialog])(
    '通知返回按钮位于标题左侧并关闭当前页',
    (Dialog) => {
      const close = vi.fn();
      const host = fixture(h(Dialog, { open: true, requests: [], onClose: close }));
      const header = host.querySelector('header')!;
      const back = header.querySelector<HTMLButtonElement>('[aria-label="返回"]')!;
      expect(header.firstElementChild).toBe(back);
      expect(host.querySelector('.weq-profile-close')).toBeNull();
      act(() => back.click());
      expect(close).toHaveBeenCalledOnce();
    },
  );
  it('已同意的好友通知也能打开对应名片，不触发关闭或审批', () => {
    const open = vi.fn(),
      close = vi.fn();
    const host = fixture(
      h(ContactNoticeDialog, {
        open: true,
        requests: [friend],
        onClose: close,
        onOpenProfile: open,
      }),
    );
    click(host);
    expect(open).toHaveBeenCalledWith(user, { x: 42, y: 64 }, undefined);
    expect(close).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="同意申请"]')).toBeNull();
  });
  it('群通知传入通知所属群，退群通知同样可查看头像名片', () => {
    const open = vi.fn();
    const host = fixture(
      h(GroupNoticeDialog, {
        open: true,
        requests: [{ ...group, action: '退出了群聊' }],
        onClose: vi.fn(),
        onOpenProfile: open,
      }),
    );
    click(host);
    expect(open).toHaveBeenCalledWith(user, { x: 42, y: 64 }, { code: '123', name: '通知所属群' });
  });
  it.each(['friend', 'doubtFriend', 'group', 'filteredGroup'] as const)(
    '在线申请 %s 的头像也能查看名片，仅 QQ 号不伪造 UID',
    (kind) => {
      const isGroup = kind === 'group' || kind === 'filteredGroup';
      state.operations = [
        {
          kind,
          token: 'opaque',
          uid: '',
          uin: '10002',
          name: '申请人',
          message: '你好',
          groupId: isGroup ? '123' : '',
          groupName: isGroup ? '通知所属群' : '',
        },
      ];
      const open = vi.fn();
      const props = { open: true, requests: [], onClose: vi.fn(), onOpenProfile: open };
      const host = fixture(isGroup ? h(GroupNoticeDialog, props) : h(ContactNoticeDialog, props));
      click(host);
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({ id: '', identityLabel: 'QQ', identityValue: '10002' }),
        { x: 42, y: 64 },
        isGroup ? { code: '123', name: '通知所属群' } : undefined,
      );
    },
  );
  it('键盘激活使用头像位置定位名片，不跳到左上角', () => {
    const open = vi.fn();
    const host = fixture(
      h(ContactNoticeDialog, {
        open: true,
        requests: [friend],
        onClose: vi.fn(),
        onOpenProfile: open,
      }),
    );
    const button = host.querySelector<HTMLButtonElement>('.notice-avatar-button')!;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 120, 32, 32));
    act(() => button.click());
    expect(open).toHaveBeenCalledWith(user, { x: 132, y: 152 }, undefined);
  });
});
