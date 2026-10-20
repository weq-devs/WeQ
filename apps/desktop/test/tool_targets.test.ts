/**
 * 浮动工具主按钮的「按当前界面直达」规则。
 *
 * 这层是纯函数，最容易在改 UI 时悄悄漂移：以前点主按钮永远打开完整导出面板，
 * 现在要按当前界面落到具体会话/空间/收藏，并且不支持的页面必须给出禁用原因。
 */

import { expect, it } from 'vitest';
import {
  analysisTargetForWorkspace,
  exportEntryForWorkspace,
  type WorkspaceContext,
} from '../src/renderer/src/lib/toolTargets';
import type {
  Conversation,
  GroupConversation,
} from '../src/renderer/src/im-template/template/types';

const group: GroupConversation = {
  id: '777',
  type: 'group',
  updatedAt: '2026-10-01T00:00:00.000Z',
  lastMessage: null,
  otherUser: null,
  group: {
    id: '777',
    name: '合成群',
    identityLabel: '群号',
    identityValue: '777',
    avatarUrl: null,
    announcement: null,
    memberCount: 2,
    role: 'member',
  },
  members: [],
};

const direct: Conversation = {
  id: 'u_peer',
  type: 'direct',
  updatedAt: '2026-10-01T00:00:00.000Z',
  lastMessage: null,
  otherUser: {
    id: 'u_peer',
    identityLabel: 'QQ',
    identityValue: '10001',
    username: 'u_peer',
    displayName: '合成好友',
    avatarUrl: null,
  },
  group: null,
  members: [],
  chatType: 1,
};

function ctx(partial: Partial<WorkspaceContext>): WorkspaceContext {
  return { view: 'messages', ...partial };
}

it('消息页直接导出当前会话，并按会话种类落到对应消息源', () => {
  const groupEntry = exportEntryForWorkspace(ctx({ conversation: group }));
  expect(groupEntry.mode).toBe('full');
  expect(groupEntry.fixedScope).toBe(true);
  expect(groupEntry.selection).toEqual({
    owner: { kind: 'messages', container: 'group:777' },
    scope: { type: 'all' },
  });

  const directEntry = exportEntryForWorkspace(ctx({ conversation: direct }));
  expect(directEntry.selection).toEqual({
    owner: { kind: 'messages', container: 'c2c:u_peer' },
    scope: { type: 'all' },
  });
});

it('空间 / 收藏 / 联系人页各自进入自己的导出种类', () => {
  expect(exportEntryForWorkspace(ctx({ view: 'qzone', spaceUin: '10002' }))).toMatchObject({
    mode: 'qzone',
    selection: { owner: { kind: 'qzone-posts', container: '10002' } },
  });
  expect(exportEntryForWorkspace(ctx({ view: 'collections' }))).toMatchObject({
    mode: 'collection',
    selection: { owner: { kind: 'collections', container: 'all' } },
  });
  expect(exportEntryForWorkspace(ctx({ view: 'contacts' })).mode).toBe('contacts');
});

it('设置 / 邮箱这类没有当前内容的页面回退到聊天消息的完整选择，按钮仍可点', () => {
  for (const view of ['home', 'mail', 'annual', 'settings']) {
    const entry = exportEntryForWorkspace(ctx({ view }));
    expect(entry.mode).toBe('full');
    expect(entry.selection).toBeUndefined();
  }
});

it('克隆体导出走生成内容，聚合入口不硬猜会话', () => {
  const clone: Conversation = {
    type: 'direct',
    id: 'virtual:persona:p1',
    updatedAt: '2026-10-01T00:00:00.000Z',
    lastMessage: null,
    otherUser: {
      id: 'virtual:persona:p1',
      identityLabel: '虚拟',
      identityValue: '',
      username: '克隆体',
      displayName: '克隆体',
      avatarUrl: null,
    },
    group: null,
    members: [],
  };
  const entry = exportEntryForWorkspace(ctx({ conversation: clone }));
  expect(entry.mode).toBe('generated');
  expect(entry.selection?.owner).toEqual({
    kind: 'clone-messages',
    container: JSON.stringify(['persona', 'p1', null]),
  });

  const merged: Conversation = {
    type: 'merged',
    id: 'merged:official',
    mergedKind: 'official',
    title: '公众号',
    avatarUrl: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
    lastMessage: null,
    otherUser: null,
    group: null,
    members: [],
  };
  // 聚合入口没有单一会话：进聊天消息面板自己挑，不再禁用。
  expect(exportEntryForWorkspace(ctx({ conversation: merged })).selection).toBeUndefined();
});

it('报告只对群聊与好友私聊生成，其他会话与页面返回空目标', () => {
  expect(analysisTargetForWorkspace(ctx({ conversation: group }))).toEqual({
    kind: 'group',
    groupCode: '777',
  });
  expect(analysisTargetForWorkspace(ctx({ conversation: direct }))).toEqual({
    kind: 'buddy',
    peerUid: 'u_peer',
  });
  expect(
    analysisTargetForWorkspace(
      ctx({ conversation: { ...direct, chatType: 103, id: 'u_official' } }),
    ),
  ).toBeNull();
  expect(analysisTargetForWorkspace(ctx({ view: 'settings' }))).toBeNull();
  expect(analysisTargetForWorkspace(ctx({ view: 'collections' }))).toBeNull();
});
