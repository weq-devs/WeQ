import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { bindNoticeOperations, type NoticeOperation } from '../src/renderer/src/lib/contactNotice';
import { useNoticeUnread } from '../src/renderer/src/hooks/useNoticeUnread';
import type {
  ContactRequest,
  GroupJoinRequest,
} from '../src/renderer/src/im-template/template/types';

const operation: NoticeOperation = {
  kind: 'group',
  token: 'opaque',
  uid: 'u_peer',
  uin: '10002',
  groupId: '123',
  name: '申请人',
  groupName: '测试群',
  message: '你好',
};
const user = {
  id: 'u_peer',
  identityValue: '10002',
  identityLabel: 'QQ',
  username: 'u_peer',
  displayName: '申请人',
  avatarUrl: null,
};
const group: GroupJoinRequest = {
  id: 'group-a',
  handleState: 'pending',
  action: '申请加入',
  message: null,
  systemRemark: null,
  createdAt: '2026-10-19T01:00:00Z',
  respondedAt: null,
  user,
  operator: null,
  group: {
    id: '123',
    conversationId: '123',
    identityLabel: 'Group',
    identityValue: '123',
    name: '测试群',
    avatarUrl: null,
    announcement: null,
    memberCount: 1,
  },
};
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  window.localStorage.clear();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
describe('通知卡片操作匹配', () => {
  it('退群、处理结果和发出的好友申请不绑定操作', () => {
    const notices = [
      { ...group, action: '退出了群聊' },
      { ...group, handleState: 'agreed' as const },
    ];
    expect(bindNoticeOperations(notices, [operation]).cards.every((r) => !r.operation)).toBe(true);
    const outgoing: ContactRequest = {
      id: 'friend-a',
      user,
      direction: 'outgoing',
      status: 'pending',
      message: null,
      createdAt: group.createdAt,
      respondedAt: null,
    };
    expect(
      bindNoticeOperations([outgoing], [{ ...operation, kind: 'friend', groupId: '' }]).cards[0]
        ?.operation,
    ).toBeUndefined();
  });
  it('按群和身份匹配，只绑定最新申请且不串过滤收件箱', () => {
    const latest = { ...group, id: 'new', createdAt: '2026-10-19T02:00:00Z' };
    const result = bindNoticeOperations([group, latest], [operation]);
    expect(result.cards.map((r) => r.operation?.token)).toEqual([undefined, 'opaque']);
    expect(result.remaining).toEqual([]);
    expect(
      bindNoticeOperations([{ ...group, isDoubt: true }], [operation]).cards[0]?.operation,
    ).toBeUndefined();
    expect(
      bindNoticeOperations([{ ...group, group: { ...group.group, id: '456' } }], [operation])
        .cards[0]?.operation,
    ).toBeUndefined();
  });
});
describe('通知红点', () => {
  it.each(['friend', 'group'] as const)(
    '查看不同批次后重载保留已读，同号不同来源独立：%s',
    (kind) => {
      const host = document.createElement('div');
      const root = createRoot(host);
      cleanups.push(() => act(() => root.unmount()));
      function Probe({ source, ids, open }: { source: string; ids: string[]; open: boolean }) {
        return h('span', null, useNoticeUnread(`10001:${source}`, kind, ids, open, true));
      }
      const render = (source: string, ids: string[], open = false) =>
        act(() => root.render(h(Probe, { source, ids, open })));
      render('source-a', ['old-1', 'old-2'], true);
      render('source-a', ['new-1'], true);
      act(() => root.render(null));
      render('source-a', ['old-1', 'old-2', 'new-1']);
      expect(host.textContent).toBe('0');
      render('source-b', ['old-1', 'old-2', 'new-1']);
      expect(host.textContent).toBe('3');
      render('source-a', ['old-1', 'old-2', 'new-1', 'new-2']);
      expect(host.textContent).toBe('1');
    },
  );
  it('进入即清除，重挂载不复现，新通知重新点亮，账号与类别独立', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    cleanups.push(() => act(() => root.unmount()));
    function Probe({
      account,
      kind,
      ids,
      open,
      ready = true,
    }: {
      account: string;
      kind: 'friend' | 'group';
      ids: string[];
      open: boolean;
      ready?: boolean;
    }) {
      return h('span', null, useNoticeUnread(account, kind, ids, open, ready));
    }
    const render = (
      account = 'a',
      kind: 'friend' | 'group' = 'friend',
      ids = ['1'],
      open = false,
      ready = true,
    ) => act(() => root.render(h(Probe, { account, kind, ids, open, ready })));
    render();
    expect(host.textContent).toBe('1');
    render('a', 'friend', ['1'], true);
    expect(host.textContent).toBe('0');
    render();
    expect(host.textContent).toBe('0');
    render('a', 'friend', ['1', '2']);
    expect(host.textContent).toBe('1');
    render('b');
    expect(host.textContent).toBe('1');
    render('a', 'group');
    expect(host.textContent).toBe('1');
    act(() => root.render(null));
    render();
    expect(host.textContent).toBe('0');
    render('a', 'friend', ['3'], true, false);
    render('a', 'friend', ['3']);
    expect(host.textContent).toBe('1');
  });
});
