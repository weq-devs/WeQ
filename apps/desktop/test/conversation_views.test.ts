// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Conversation } from '../src/renderer/src/im-template/template/types';
import {
  activeConversationBelongsToView,
  conversationViewRows,
  conversationViewForTarget,
  conversationSupportsAction,
  conversationViewActions,
  splitConversationAction,
  type ConversationViewDirectory,
} from '../src/renderer/src/lib/conversationViews';
import {
  archivedConversationRow,
  assistantConversationRow,
  feedConversationRow,
  generatedAggregateRow,
} from '../src/renderer/src/lib/conversationDirectoryRows';
import { virtualConversationRow } from '../src/renderer/src/lib/conversationDirectory';
import { generatedDraftSummary, latestGeneratedActivity } from '../src/shared/generated_reply';

it('生成会话沿用实际消息时间，跳过空占位，汇总摘要不被更新的空会话覆盖', () => {
  const summary = latestGeneratedActivity([
    { role: 'assistant', text: '已生成\n报告', ts: 12000 },
    { role: 'assistant', text: '', ts: 13500, status: 'running' },
  ]);
  expect(summary).toMatchObject({ preview: '已生成 报告', lastMessageTime: 13 });
  const row = assistantConversationRow({ id: 'hit', title: '会议', updatedAt: 13500, ...summary });
  const empty = assistantConversationRow({ id: 'new', title: '新会话', updatedAt: 16000 });
  expect(generatedAggregateRow('assistant', [row, empty]).lastMessage?.body).toBe(
    '会议 · 已生成 报告',
  );
  const group = latestGeneratedActivity(
    [{ senderKind: 'persona', senderId: 'clone-a', text: '[[voice:asset]]', ts: 22000 }],
    () => '成员甲',
  );
  expect(
    virtualConversationRow({ id: 'group', kind: 'group', ownerId: 'g', name: '合成群', ...group })
      .lastMessage?.body,
  ).toBe('成员甲：[语音]');
  expect(generatedDraftSummary('[[ai-image:encoded]]\n草稿')).toBe('[图片] 草稿');
});
import {
  conversationAnalysisTarget,
  conversationRoamingTarget,
} from '../src/renderer/src/lib/conversationActions';
import { preferenceDefaults, validatePreferencePatch } from '@weq/service/client-preferences';

const direct = (id: string, name = id): Conversation => ({
  id,
  type: 'direct',
  otherUser: {
    id,
    username: id,
    displayName: name,
    identityLabel: 'QQ',
    identityValue: '10001',
    avatarUrl: null,
  },
  group: null,
  members: [],
  updatedAt: '2026-11-13T04:00:00Z',
  lastMessage: null,
});
const group: Conversation = {
  id: '12345',
  type: 'group',
  otherUser: null,
  group: {
    id: '12345',
    name: '分类内测试群',
    identityLabel: 'Group',
    identityValue: '12345',
    avatarUrl: null,
    announcement: null,
    memberCount: 2,
    role: 'member',
  },
  members: [],
  updatedAt: '2026-11-13T04:00:00Z',
  lastMessage: null,
};
const helper: Conversation = {
  id: 'merged:group-assistant',
  type: 'merged',
  mergedKind: 'groupAssistant',
  title: '群助手',
  avatarUrl: null,
  otherUser: null,
  group: null,
  members: [],
  updatedAt: '',
  lastMessage: null,
};
const clone = virtualConversationRow({
  id: 'virtual:persona:p1',
  kind: 'persona',
  ownerId: 'p1',
  name: '克隆同学',
});
const assistant = assistantConversationRow({ id: 's1', title: '会议整理', updatedAt: 12345 });
const official = feedConversationRow(
  { id: 'u_official', name: '公众号甲', sendTime: '1000', prompt: '推文' },
  'official',
);
const service = feedConversationRow(
  { id: '1000', name: '服务号甲', sendTime: '1000', prompt: '通知' },
  'service',
);
const hidden = { ...direct('u_hidden', '隐藏同学'), hidden: true };
const deleted = { ...direct('u_deleted', '删除同学'), deleted: true };
const directory: ConversationViewDirectory = {
  regular: [
    direct('u_regular', '普通同学'),
    helper,
    generatedAggregateRow('clone', [clone]),
    generatedAggregateRow('assistant', [assistant]),
  ],
  groupAssistant: [group],
  official: [official],
  service: [service],
  guild: [{ ...direct('guild:n1'), directoryKind: 'guild' }],
  hidden: [hidden],
  deleted: [deleted],
  clone: [clone],
  assistant: [assistant],
};
const options = { includeHidden: false, includeDeleted: false };

describe('会话视图的平铺集合', () => {
  it('全局命中按真实目录归类，不受当前视图及全部会话开关限制', () => {
    expect(conversationViewForTarget(directory, hidden.id)).toBe('hidden');
    expect(conversationViewForTarget(directory, deleted.id)).toBe('deleted');
    expect(conversationViewForTarget(directory, group.id)).toBe('groupAssistant');
    expect(conversationViewForTarget(directory, official.id)).toBe('official');
    expect(conversationViewForTarget(directory, service.id)).toBe('service');
    expect(conversationViewForTarget(directory, clone.id)).toBe('clone');
    expect(conversationViewForTarget(directory, assistant.id)).toBe('assistant');
    expect(conversationViewForTarget(directory, 'u_regular')).toBe('regular');
  });
  it('常规搜索只匹配平铺行和聚合入口，不越过分类找内部会话', () => {
    expect(conversationViewRows(directory, 'regular', options, '分类内测试群')).toEqual([]);
    expect(conversationViewRows(directory, 'regular', options, '群助手')).toEqual([helper]);
    expect(conversationViewRows(directory, 'groupAssistant', options, '分类内测试群')).toEqual([
      group,
    ]);
    expect(
      conversationViewRows(directory, 'regular', options).some((row) => row.id === clone.id),
    ).toBe(false);
  });
  it('已打开的聊天按实际归属保留，聚合入口不代表当前聊天在常规视图', () => {
    expect(activeConversationBelongsToView(directory, 'regular', options, group)).toBe(false);
    expect(activeConversationBelongsToView(directory, 'groupAssistant', options, group)).toBe(true);
    expect(activeConversationBelongsToView(directory, 'all', options, group)).toBe(true);
    const newSession = { id: 'assistant:new', category: 'assistant' } as const;
    expect(activeConversationBelongsToView(directory, 'assistant', options, newSession)).toBe(true);
    expect(activeConversationBelongsToView(directory, 'all', options, newSession)).toBe(true);
    expect(activeConversationBelongsToView(directory, 'clone', options, newSession)).toBe(false);
  });
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('全部会话独立跟随两个开关 %s/%s，永不包含聚合行', (includeHidden, includeDeleted) => {
    const rows = conversationViewRows(directory, 'all', { includeHidden, includeDeleted });
    expect(rows.some((row) => row.type === 'merged')).toBe(false);
    expect(rows.some((row) => row.id === hidden.id)).toBe(includeHidden);
    expect(rows.some((row) => row.id === deleted.id)).toBe(includeDeleted);
    expect(rows).toContain(clone);
    expect(rows).toContain(assistant);
    expect(rows).toContain(official);
    expect(rows).toContain(service);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });
  it('即使其他集合重复出现已归档行，关闭范围开关时也不能漏入全部会话', () => {
    const polluted = { ...directory, groupAssistant: [group, hidden, deleted] };
    expect(conversationViewRows(polluted, 'all', options).map((row) => row.id)).not.toContain(
      hidden.id,
    );
    expect(conversationViewRows(polluted, 'all', options).map((row) => row.id)).not.toContain(
      deleted.id,
    );
    for (const [row, range] of [
      [hidden, 'includeHidden'],
      [deleted, 'includeDeleted'],
    ] as const) {
      expect(activeConversationBelongsToView(polluted, 'all', options, row)).toBe(false);
      expect(
        activeConversationBelongsToView(polluted, 'all', { ...options, [range]: true }, row),
      ).toBe(true);
    }
  });
});
describe('会话操作能力', () => {
  it('分类不支持的项目不展示，空选区不改变视图的项目集合', () => {
    expect(conversationViewActions('official')).toEqual(['export']);
    expect(conversationViewActions('assistant')).toEqual(['export', 'delete']);
    expect(conversationViewActions('hidden')).not.toContain('read');
    expect(conversationViewActions('deleted')).not.toContain('read');
  });
  it('聚合入口不支持批量能力，特殊会话不冒充普通 QQ 会话', () => {
    for (const action of conversationViewActions('all'))
      expect(conversationSupportsAction(helper, action)).toBe(false);
    for (const row of [official, service, directory.guild[0]!]) {
      expect(conversationSupportsAction(row, 'export')).toBe(true);
      expect(conversationSupportsAction(row, 'roaming')).toBe(false);
      expect(conversationSupportsAction(row, 'read')).toBe(false);
      expect(conversationAnalysisTarget(row)).toBeNull();
      expect(conversationRoamingTarget(row)).toBeNull();
    }
    expect(conversationSupportsAction(hidden, 'read')).toBe(false);
    expect(conversationSupportsAction(deleted, 'read')).toBe(false);
    expect(conversationSupportsAction(hidden, 'roaming')).toBe(true);
    expect(conversationSupportsAction(group, 'roster')).toBe(true);
  });
  it('混选按目标能力划分，永久删除仅限生成对象', () => {
    const selection = [group, hidden, deleted, clone, assistant, official];
    expect(splitConversationAction(selection, 'delete')).toEqual({
      supported: [clone, assistant],
      unsupported: [group, hidden, deleted, official],
    });
    expect(splitConversationAction(selection, 'roster').supported).toEqual([group]);
    expect(splitConversationAction(selection, 'read').supported).toEqual([group]);
    expect(splitConversationAction(selection, 'export').supported).toHaveLength(selection.length);
  });
});
it('未加载最近会话页也能从真实隐藏记录重建群聊和私聊，使用本地名称', () => {
  const record = {
    targetUid: '22222',
    targetUin: '0',
    chatType: 'KCHATTYPEGROUP',
    sendTime: '1000',
    senderUid: 'u_peer',
  };
  const row = archivedConversationRow(record, 'hidden', undefined, '本地群名');
  expect(row.type).toBe('group');
  expect(row.hidden).toBe(true);
  expect(row.type === 'group' && row.group.name).toBe('本地群名');
  const peer = archivedConversationRow({ ...record, targetUid: 'u_peer', chatType: 1 }, 'deleted', {
    nick: '云昵称',
    remark: '本地备注',
    uin: '10002',
  });
  expect(peer.deleted).toBe(true);
  expect(peer.type === 'direct' && peer.otherUser.displayName).toBe('本地备注');
  expect(peer.type === 'direct' && peer.otherUser.identityValue).toBe('10002');
});
it('会话视图的范围与关闭行为是独立的应用共享偏好，默认都关闭', () => {
  expect(preferenceDefaults.allConversationsIncludeHidden).toBe(false);
  expect(preferenceDefaults.allConversationsIncludeDeleted).toBe(false);
  expect(preferenceDefaults.closeConversationOutsideView).toBe(false);
  expect(() =>
    validatePreferencePatch({
      allConversationsIncludeHidden: true,
      allConversationsIncludeDeleted: false,
      closeConversationOutsideView: true,
    }),
  ).not.toThrow();
  expect(() => validatePreferencePatch({ allConversationsIncludeHidden: 'true' })).toThrow();
});
