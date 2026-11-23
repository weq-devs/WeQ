import { expect, it, vi } from 'vitest';
import { createConversationProjection } from '../src/renderer/src/lib/conversationProjection';
import { createTemplateDemoData } from './support/templateDemoData';
import type { Conversation } from '../src/renderer/src/im-template/template/types';
import { createRecentContactProjection } from '../src/renderer/src/views/workspace/identity';
import type { RecentContactWire } from '../src/renderer/src/views/workspace/types';

const demo = createTemplateDemoData();
const group = demo.conversations.find((row) => row.type === 'group')!;
const defaults = { pinned: false, muted: false, blocked: false };
const emptyDirectory = { pinStateKnown: false, activityTime: 0, highlights: null };

function contactRow(
  targetUid: string,
  overrides: Partial<RecentContactWire> = {},
): RecentContactWire {
  return {
    chatType: 2,
    msgSeq: '1',
    senderUid: 'u_peer',
    targetUid,
    targetUin: targetUid,
    sendTime: '1700000000',
    topTime: '0',
    pinned: false,
    preview: { kind: 'text', textContent: '消息' },
    senderDisplayName: '',
    senderNick: '',
    targetDisplayName: '',
    senderRemark: '',
    targetAvatar: '',
    targetRemark: '',
    targetGroupNick: '',
    notifyLevel: 1,
    tempSourceGroupCode: '0',
    ...overrides,
  };
}

it('四千行目录的等值资料回填保留引用，单个群名片变化只重建对应会话', () => {
  const project = createRecentContactProjection(demo.user);
  const rows = Array.from({ length: 4000 }, (_, index) => contactRow(String(10_000 + index)));
  const sources = {
    groupTitles: new Map(rows.map((row) => [row.targetUid, row.targetUid])),
    displayNames: new Map([['u_peer', '全局名称']]),
    groupNames: new Map(rows.map((row) => [row.targetUid, new Map([['u_peer', '群名片']])])),
    profiles: new Map<string, { nick: string; remark: string }>(),
    botUids: new Set<string>(),
  };
  const first = rows.map((row) => project(row, sources));
  const next = {
    ...sources,
    groupNames: new Map(
      rows.map((row) => [
        row.targetUid,
        new Map([['u_peer', row.targetUid === '12000' ? '新群名片' : '群名片']]),
      ]),
    ),
  };
  const after = rows.map((row) => project(row, next));
  expect(after.filter((row, index) => row !== first[index])).toEqual([after[2000]]);
  expect(after[2000]?.lastMessage?.senderDisplayName).toBe('新群名片');
});

it('灰条中从元素取出的 QQ 号及临时会话来源名变化后刷新，缺失资料到达不沿用旧投影', () => {
  const project = createRecentContactProjection(demo.user);
  const tip = contactRow('123', {
    preview: {
      kind: 'grayTipPoke',
      grayTipXmlContent: '<gtip><qq uin="u_peer"/><nor txt="戳了戳"/><qq uin="u_other"/></gtip>',
      actionAttributes: [{ key: 'uin_str1', value: '10001' }],
    },
  });
  const direct = contactRow('u_other', {
    chatType: 100,
    targetUin: '20001',
    tempSourceGroupCode: '123',
    targetGroupNick: '临时群昵称',
  });
  const sources = {
    groupTitles: new Map([['123', '原群名']]),
    displayNames: new Map<string, string>(),
    groupNames: new Map<string, Map<string, string>>(),
    profiles: new Map<string, { nick: string; remark: string }>(),
    botUids: new Set<string>(),
  };
  const before = project(tip, sources);
  expect(before?.lastMessage?.body).toContain('10001');
  const renamed = {
    ...sources,
    displayNames: new Map([['10001', '本地备注']]),
    groupTitles: new Map([['123', '新群名']]),
    profiles: new Map([['u_other', { nick: '好友名称', remark: '好友备注' }]]),
  };
  expect(project(tip, renamed)?.lastMessage?.body).toContain('本地备注');
  expect(project(direct, sources)?.otherUser?.displayName).toBe('临时群昵称');
  expect(project(direct, renamed)).toMatchObject({
    otherUser: { displayName: '好友备注' },
    tempSourceGroupName: '新群名',
  });
});

it('未变目录输入复用投影，等值元数据保留行与嵌套引用，基础资料变化仍替换', () => {
  const cache = createConversationProjection(
    (_detail: object, previous: Conversation = group) => previous,
  );
  const base = { ...group, unreadCount: 0 };
  const state = { ...emptyDirectory, pinStateKnown: true };
  const first = cache.directory(base, state, defaults);
  expect(cache.directory(base, { ...state }, defaults)).toBe(first);
  expect(cache.directory(base, { ...state, unreadCount: 0 }, defaults)).toBe(first);
  expect(first.group).toBe(base.group);
  expect(first.members).toBe(base.members);
  expect(cache.directory({ ...base, updatedAt: '2030-01-01' }, state, defaults)).not.toBe(first);
  expect(
    createConversationProjection(
      (_detail: object, previous: Conversation = group) => previous,
    ).directory(base, state, defaults),
  ).not.toBe(first);
});

it('未读、高亮、置顶及活动时间可清零撤销，空输入恢复基础行且不保留旧投影', () => {
  const cache = createConversationProjection(
    (_detail: object, previous: Conversation = group) => previous,
  );
  const base = { ...group, preference: { pinned: true, muted: true, blocked: true } };
  const state = {
    ...emptyDirectory,
    pinStateKnown: true,
    unreadCount: 5,
    pinnedAt: 99,
    activityTime: 200,
    highlights: [{ kind: 'atMe' as const, rawKind: 1000, senderUid: 'u_peer', msgSeq: '1' }],
  };
  const first = cache.directory(base, state, defaults);
  expect(first).toMatchObject({
    unreadCount: 5,
    activityTime: 200,
    pinnedAt: 99,
    pinStateKnown: true,
    preference: { pinned: true, muted: true, blocked: true },
  });
  const cleared = cache.directory(
    base,
    { ...emptyDirectory, pinStateKnown: true, unreadCount: 0 },
    defaults,
  );
  expect(cleared).toMatchObject({
    unreadCount: 0,
    activityTime: 0,
    pinStateKnown: true,
    preference: { pinned: false, muted: true, blocked: true },
    highlights: null,
  });
  expect(cleared.pinnedAt).toBeUndefined();
  expect(base.preference.pinned).toBe(true);
  expect(cache.directory(base, emptyDirectory, defaults)).toBe(base);
  expect(cache.directory(base, state, defaults)).not.toBe(first);
});

it('元数据保存本轮字段快照，默认偏好变更和 NaN 活动时间仍正确处理', () => {
  const cache = createConversationProjection(
    (_detail: object, previous: Conversation = group) => previous,
  );
  const base = { ...group, preference: undefined };
  const state = {
    ...emptyDirectory,
    pinStateKnown: true,
    unreadCount: 1,
    activityTime: Number.NaN,
  };
  const first = cache.directory(base, state, defaults);
  expect(cache.directory(base, { ...state }, defaults)).toBe(first);
  state.unreadCount = 2;
  const changed = cache.directory(base, state, defaults);
  expect(changed).not.toBe(first);
  expect(changed.unreadCount).toBe(2);
  expect(Number.isNaN(changed.activityTime)).toBe(true);
  const next = cache.directory(base, state, { ...defaults, muted: true });
  expect(next.preference).toEqual({ pinned: false, muted: true, blocked: false });
});

it('未变群资料和不同层的会话投影分别复用，不因基准行交替而打散缓存', () => {
  const project = vi.fn((_detail: object, previous: Conversation = group) => ({ ...previous }));
  const cache = createConversationProjection(project);
  const detail = {};
  const base = { ...group },
    badge = { ...group, unreadCount: 2 };
  const plain = cache.group(detail);
  const first = cache.group(detail, base);
  const second = cache.group(detail, badge);
  expect(cache.group(detail, base)).toBe(first);
  expect(cache.group(detail, badge)).toBe(second);
  expect(cache.group(detail)).toBe(plain);
  expect(project).toHaveBeenCalledTimes(3);
});

it('元数据和会话任一不可变输入变化均重投影，新上下文不借用旧账号结果', () => {
  const project = vi.fn((_detail: object, previous: Conversation = group) => ({ ...previous }));
  const cache = createConversationProjection(project);
  const detail = {};
  const old = cache.group(detail, group);
  expect(cache.group({ ...detail }, group)).not.toBe(old);
  expect(cache.group(detail, { ...group, unreadCount: 8 })).not.toBe(old);
  expect(createConversationProjection(project).group(detail, group)).not.toBe(old);
});

it('成员状态按输入和归属复用，变更仍可撤销，不给非群会话套群资料', () => {
  const cache = createConversationProjection(
    (_detail: object, previous: Conversation = group) => previous,
  );
  const unknown = { ...group, group: { ...group.group, membershipKnown: false } };
  const listed = cache.membership(unknown, true);
  expect(cache.membership(unknown, true)).toBe(listed);
  expect(cache.membership(listed, true)).toBe(listed);
  const left = cache.membership(unknown, false);
  expect(left).not.toBe(listed);
  expect(left.type === 'group' && left.group.listed).toBe(false);
  const direct = demo.conversations.find((row) => row.type === 'direct')!;
  expect(cache.membership(direct, true)).toBe(direct);
});
