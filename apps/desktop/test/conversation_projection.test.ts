import { expect, it, vi } from 'vitest';
import { createConversationProjection } from '../src/renderer/src/lib/conversationProjection';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { Conversation } from '../src/renderer/src/im-template/template/types';

const demo = createTemplateDemoData();
const group = demo.conversations.find((row) => row.type === 'group')!;
const defaults = { pinned: false, muted: false, blocked: false };
const emptyDirectory = { pinStateKnown: false, activityTime: 0, highlights: null };

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
