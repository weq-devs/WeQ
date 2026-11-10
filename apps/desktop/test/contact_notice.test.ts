import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import {
  bindNoticeOperations,
  groupNoticeId,
  type NoticeOperation,
} from '../src/renderer/src/lib/contactNotice';
import { NOTICE_SEEN_LIMIT, useNoticeUnread } from '../src/renderer/src/hooks/useNoticeUnread';
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
  it.each(['friend', 'group'] as const)('同步其他窗口已读，重新聚焦也补读：%s', (kind) => {
    const host = document.createElement('div');
    const root = createRoot(host);
    cleanups.push(() => act(() => root.unmount()));
    const key = `weq:notice-seen:windows:${kind}`;
    const prefix = kind === 'friend' ? 'buddy-request:u_peer' : 'group-notify:123:u_peer';
    const ids = [100, 200, 300].map((time) => `${prefix}:${time}`);
    window.localStorage.setItem(key, JSON.stringify([ids[0]]));
    function Probe() {
      return h('span', null, useNoticeUnread('windows', kind, ids, false, true));
    }
    act(() => root.render(h(Probe)));
    expect(host.textContent).toBe('2');
    window.localStorage.setItem(key, JSON.stringify(ids.slice(0, 2)));
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: `${key}-other` })));
    expect(host.textContent).toBe('2');
    act(() => window.dispatchEvent(new StorageEvent('storage', { key })));
    expect(host.textContent).toBe('1');
    window.localStorage.setItem(key, JSON.stringify(ids));
    act(() => window.dispatchEvent(new Event('focus')));
    expect(host.textContent).toBe('0');
    act(() => root.render(null));
    act(() => root.render(h(Probe)));
    expect(host.textContent).toBe('0');
  });

  it('同页多个通知入口也同步已读', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    cleanups.push(() => act(() => root.unmount()));
    window.localStorage.setItem('weq:notice-seen:shared:friend', JSON.stringify(['old']));
    function Probe({ open }: { open: boolean }) {
      return h('span', null, useNoticeUnread('shared', 'friend', ['old', 'new'], open, true));
    }
    act(() => root.render(h('div', null, h(Probe, { open: false }), h(Probe, { open: false }))));
    expect(host.textContent).toBe('11');
    act(() => root.render(h('div', null, h(Probe, { open: true }), h(Probe, { open: false }))));
    expect(host.textContent).toBe('00');
  });

  it('已读 ID 淘汰后仍保留时间水位，相同时间的其他新通知不被吞掉', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    cleanups.push(() => act(() => root.unmount()));
    function Probe({ ids }: { ids: string[] }) {
      return h('span', null, useNoticeUnread('bounded', 'friend', ids, false, true));
    }
    const newest = NOTICE_SEEN_LIMIT + 10;
    const ids = Array.from(
      { length: newest },
      (_, index) => `buddy-request:u_peer:${newest - index}`,
    );
    act(() => root.render(h(Probe, { ids })));
    expect(host.textContent).toBe('0');
    const stored = JSON.parse(
      window.localStorage.getItem('weq:notice-seen:bounded:friend') ?? '{}',
    );
    expect(stored.seen).toHaveLength(NOTICE_SEEN_LIMIT);
    expect(stored.readThrough).toBe(newest);
    act(() => root.render(null));
    act(() => root.render(h(Probe, { ids })));
    expect(host.textContent).toBe('0');
    act(() => root.render(h(Probe, { ids: [...ids, `buddy-request:u_other:${newest}`] })));
    expect(host.textContent).toBe('1');
  });
  it.each(['friend', 'group'] as const)(
    '更新后重新读到较早历史不亮红点，离线期间的新通知仍提示：%s',
    (kind) => {
      const host = document.createElement('div');
      const root = createRoot(host);
      cleanups.push(() => act(() => root.unmount()));
      const prefix = kind === 'friend' ? 'buddy-request:u_peer' : 'group-notify:123:u_peer';
      const id = (timestamp: number) => `${prefix}:${timestamp}`;
      // 直接提供旧版存储格式，验证升级迁移而非用新实现生成夹具。
      window.localStorage.setItem(
        `weq:notice-seen:upgrade:${kind}`,
        JSON.stringify([id(200), id(300)]),
      );
      function Probe({ times, open }: { times: number[]; open: boolean }) {
        return h('span', null, useNoticeUnread('upgrade', kind, times.map(id), open, true));
      }
      const render = (times: number[], open = false) =>
        act(() => root.render(h(Probe, { times, open })));
      render([100, 200, 300]);
      expect(host.textContent).toBe('0');
      render([100, 200, 300, 400]);
      expect(host.textContent).toBe('1');
      render([300, 400], true);
      act(() => root.render(null));
      render([50, 100, 200, 300, 400, 500]);
      expect(host.textContent).toBe('1');
    },
  );
  it('群资料补齐或处理状态变化不产生新通知，只有新记录点亮', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    cleanups.push(() => act(() => root.unmount()));
    const record = { groupUin: '123', operatedUid: 'u_peer', msgTime: 1, verifyStatus: 1 };
    function Probe({ records, groupsReady }: { records: (typeof record)[]; groupsReady: boolean }) {
      const unread = useNoticeUnread(
        'group-loading',
        'group',
        records.map(groupNoticeId),
        false,
        true,
      );
      return h('span', { 'data-groups-ready': groupsReady }, unread);
    }
    const render = (records: (typeof record)[], groupsReady: boolean) =>
      act(() => root.render(h(Probe, { records, groupsReady })));
    render([record], false);
    expect(host.textContent).toBe('0');
    render([{ ...record, verifyStatus: 2 }], true);
    expect(host.textContent).toBe('0');
    render([record, { ...record, msgTime: 2 }], true);
    expect(host.textContent).toBe('1');
  });
  it.each(['friend', 'group'] as const)(
    '首次成功读取历史通知不亮红点，之后只提醒新增：%s',
    (kind) => {
      const host = document.createElement('div');
      const root = createRoot(host);
      cleanups.push(() => act(() => root.unmount()));
      function Probe({ ids, ready }: { ids: string[]; ready: boolean }) {
        return h('span', null, useNoticeUnread('baseline', kind, ids, false, ready));
      }
      const render = (ids: string[], ready = true) =>
        act(() => root.render(h(Probe, { ids, ready })));
      render([], false);
      render(['history-1', 'history-2']);
      expect(host.textContent).toBe('0');
      act(() => root.render(null));
      render(['history-1', 'history-2']);
      expect(host.textContent).toBe('0');
      render(['history-1', 'history-2', 'new']);
      expect(host.textContent).toBe('1');
      act(() => root.render(null));
      render(['history-1', 'history-2', 'new']);
      expect(host.textContent).toBe('1');
    },
  );
  it('首次成功读取为空也建立基线，后续通知不能被吞掉', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    cleanups.push(() => act(() => root.unmount()));
    function Probe({ ids }: { ids: string[] }) {
      return h('span', null, useNoticeUnread('empty', 'friend', ids, false, true));
    }
    act(() => root.render(h(Probe, { ids: [] })));
    act(() => root.render(null));
    act(() => root.render(h(Probe, { ids: ['new'] })));
    expect(host.textContent).toBe('1');
  });
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
      expect(host.textContent).toBe('0');
      render('source-b', ['old-1', 'old-2', 'new-1', 'source-b-new']);
      expect(host.textContent).toBe('1');
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
    expect(host.textContent).toBe('0');
    render('a', 'friend', ['1'], true);
    expect(host.textContent).toBe('0');
    render();
    expect(host.textContent).toBe('0');
    render('a', 'friend', ['1', '2']);
    expect(host.textContent).toBe('1');
    render('a', 'friend', ['1', '2'], true);
    render('a', 'friend', ['1', '2']);
    expect(host.textContent).toBe('0');
    render('b');
    expect(host.textContent).toBe('0');
    render('a', 'group');
    expect(host.textContent).toBe('0');
    act(() => root.render(null));
    render();
    expect(host.textContent).toBe('0');
    render('a', 'friend', ['3'], true, false);
    render('a', 'friend', ['3']);
    expect(host.textContent).toBe('1');
  });
});
