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
  OverlayLayer: () => {
    throw new Error('联系人通知不得打开全窗口详情页或浮层');
  },
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
  createdAt: '2026-10-19T01:00:37Z',
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
    button
      .querySelector('.notice-who')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, detail, clientX: 42, clientY: 64 })),
  );
  return button;
}

describe('通知头像名片入口', () => {
  it.each([ContactNoticeDialog, GroupNoticeDialog])(
    '通知直接在所属内容面板内展示，关闭后不残留内容',
    (Dialog) => {
      const host = fixture(h(Dialog, { open: true, requests: [], onClose: vi.fn() }));
      expect(host.querySelector(':scope > .weq-notice-panel')).not.toBeNull();
      expect(document.querySelector('.weq-workspace-page')).toBeNull();
      const closed = fixture(h(Dialog, { open: false, requests: [], onClose: vi.fn() }));
      expect(closed.childElementCount).toBe(0);
    },
  );
  it.each([ContactNoticeDialog, GroupNoticeDialog])(
    '通知面板内按 Escape 返回，左侧列表焦点不触发返回',
    (Dialog) => {
      const close = vi.fn();
      const host = fixture(h(Dialog, { open: true, requests: [], onClose: close }));
      // eslint-disable-next-line no-console
      console.log(
        'SURFACES',
        [
          ...document.querySelectorAll(
            '[aria-modal="true"], [role="dialog"], .weq-overlay-layer, .weq-dialog-layer',
          ),
        ]
          .map((n) => n.className || n.tagName)
          .join(' | '),
        '| host:',
        host.innerHTML.slice(0, 120),
      );
      act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      expect(close).toHaveBeenCalledOnce();
      const outside = document.createElement('button');
      host.append(outside);
      outside.focus();
      act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      expect(close).toHaveBeenCalledOnce();
    },
  );
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
  it('群名打开通知所属群的群名片，不关闭通知或打开申请人名片', () => {
    const open = vi.fn(),
      profile = vi.fn(),
      close = vi.fn();
    const host = fixture(
      h(GroupNoticeDialog, {
        open: true,
        requests: [{ ...group, action: '退出了群聊' }],
        onClose: close,
        onOpenProfile: profile,
        onOpenGroupProfile: open,
      }),
    );
    const button = host.querySelector<HTMLButtonElement>('button.notice-group-name');
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(open).toHaveBeenCalledWith({ code: '123', name: '通知所属群' }, button);
    expect(close).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
  });
  it('好友和群通知显示北京时间日期与时分秒，群处理时间同样到秒', () => {
    const friendHost = fixture(
      h(ContactNoticeDialog, { open: true, requests: [friend], onClose: vi.fn() }),
    );
    const groupHost = fixture(
      h(GroupNoticeDialog, {
        open: true,
        requests: [{ ...group, operator: user, respondedAt: '2026-10-19T02:03:49Z' }],
        onClose: vi.fn(),
      }),
    );
    for (const host of [friendHost, groupHost]) {
      expect(host.querySelector('.notice-meta time')?.textContent).toBe('2026/10/19 09:00:37');
      expect(host.querySelector('.notice-meta time')?.getAttribute('datetime')).toBe(
        friend.createdAt,
      );
    }
    expect(groupHost.querySelector('.notice-operator')?.textContent).toContain(
      '2026/10/19 10:03:49',
    );
  });
  it.each(['group', 'filteredGroup'] as const)('在线 %s 申请的群名也能打开群名片', (kind) => {
    state.operations = [
      {
        kind,
        token: 'opaque',
        uid: user.id,
        uin: '10002',
        name: '申请人',
        message: '你好',
        groupId: '456',
        groupName: '在线申请群',
      },
    ];
    const open = vi.fn();
    const host = fixture(
      h(GroupNoticeDialog, {
        open: true,
        requests: [],
        onClose: vi.fn(),
        onOpenGroupProfile: open,
      }),
    );
    const button = host.querySelector<HTMLButtonElement>('button.notice-group-name');
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(open).toHaveBeenCalledWith({ code: '456', name: '在线申请群' }, button);
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
