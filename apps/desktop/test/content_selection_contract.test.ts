// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createToolDraft,
  freezeToolTarget,
  reduceContentSelection,
  type ContentSelection,
} from '../src/shared/content_selection';
import {
  initialContactScope,
  initialConversationIds,
  initialExportMode,
  initialGuildScope,
  initialQzoneScope,
} from '../src/renderer/src/views/export/exportScope';
import {
  analysisTargetForWorkspace,
  exportEntryForWorkspace,
  selectionForWorkspace,
  type WorkspaceContext,
} from '../src/renderer/src/lib/toolTargets';
import type {
  Conversation,
  GroupConversation,
} from '../src/renderer/src/im-template/template/types';

describe('content_selection', () => {
  const chat = { kind: 'messages', container: 'group:fixture' } as const;

  const otherChat = { kind: 'messages', container: 'c2c:fixture' } as const;

  const collection = { kind: 'collections', container: 'all' } as const;

  describe('内容选择与工具草稿', () => {
    it('另一处开始多选替换旧集合，同一处切换单条且保留顺序', () => {
      const first = reduceContentSelection(null, { type: 'select', owner: chat, ids: ['1', '3'] });
      const next = reduceContentSelection(first, { type: 'toggle', owner: chat, id: '5' });
      expect(next?.scope).toEqual({ type: 'items', ids: ['1', '3', '5'] });
      expect(reduceContentSelection(next, { type: 'toggle', owner: chat, id: '3' })?.scope).toEqual(
        {
          type: 'items',
          ids: ['1', '5'],
        },
      );
      expect(reduceContentSelection(next, { type: 'toggle', owner: otherChat, id: '8' })).toEqual({
        owner: otherChat,
        scope: { type: 'items', ids: ['8'] },
      });
      expect(
        reduceContentSelection(next, { type: 'select', owner: collection, ids: ['c'] }),
      ).toEqual({
        owner: collection,
        scope: { type: 'items', ids: ['c'] },
      });
      expect(first?.scope).toEqual({ type: 'items', ids: ['1', '3'] });
    });

    it('旧页面清理不能清掉另一处选择，空选仍保留当前多选归属', () => {
      const selected = reduceContentSelection(null, { type: 'select', owner: chat, ids: [] });
      expect(selected).toEqual({ owner: chat, scope: { type: 'items', ids: [] } });
      expect(reduceContentSelection(selected, { type: 'clear', owner: otherChat })).toBe(selected);
      expect(reduceContentSelection(selected, { type: 'clear', owner: chat })).toBeNull();
    });

    it('间断精确条目不退化成日期，草稿与内容页互不污染', () => {
      const source: ContentSelection = {
        owner: { ...chat },
        scope: { type: 'items', ids: ['1', '3', '9', '3'] },
      };
      const draft = createToolDraft('account-a', source);
      expect(draft.selection.scope).toEqual({ type: 'items', ids: ['1', '3', '9'] });
      if (draft.selection.scope.type !== 'items') throw new Error('应保持精确选择');
      draft.selection.scope.ids.splice(1, 1);
      draft.selection.owner.container = 'changed';
      expect(source.scope).toEqual({ type: 'items', ids: ['1', '3', '9', '3'] });
      expect(source.owner).toEqual(chat);
    });

    it('条件集合保持条件语义，不假称已经冻结精确条目', () => {
      const source: ContentSelection = {
        owner: collection,
        scope: { type: 'filter', conditions: { query: 'fixture', kind: 'text', before: null } },
      };
      const draft = createToolDraft('account-a', source);
      if (draft.selection.scope.type !== 'filter') throw new Error('应保持条件选择');
      draft.selection.scope.conditions.query = 'new';
      expect(source.scope).toEqual({
        type: 'filter',
        conditions: { query: 'fixture', kind: 'text', before: null },
      });
    });

    it('任务与草稿独立且拒绝跨账号使用', () => {
      const draft = createToolDraft('account-a', {
        owner: chat,
        scope: { type: 'items', ids: ['1', '3'] },
      });
      const task = freezeToolTarget('account-a', draft);
      if (draft.selection.scope.type === 'items') draft.selection.scope.ids.push('8');
      expect(task.selection.scope).toEqual({ type: 'items', ids: ['1', '3'] });
      expect(() => freezeToolTarget('account-b', draft)).toThrow('其他账号');
    });
  });
});

describe('export_scope', () => {
  describe('统一导出的上下文草稿', () => {
    it('群聊名单与群成员名单使用不同容器，空的精确选择不降级为全量', () => {
      const all: ContentSelection = {
        owner: { kind: 'contacts', container: 'group-list' },
        scope: { type: 'all' },
      };
      expect(initialExportMode(all)).toBe('contacts');
      expect(initialContactScope(all)).toEqual({ scope: 'groups', groupIds: [], memberUids: {} });
      expect(initialContactScope({ ...all, scope: { type: 'items', ids: [] } })).toEqual({
        scope: 'groups',
        groupIds: [],
        memberUids: {},
        groupListIds: [],
      });
      const selected = initialContactScope({
        ...all,
        scope: { type: 'items', ids: ['123', '123'] },
      });
      expect(selected.groupListIds).toEqual(['123']);
      expect(selected.memberUids).toEqual({});
    });
    it('空间按 UIN 与精确 tid 复制，非好友和空集合都不退回普通聊天', () => {
      const selection: ContentSelection = {
        owner: { kind: 'qzone-posts', container: '19999' },
        scope: { type: 'items', ids: ['a', 'c', 'a'] },
      };
      expect(initialExportMode(selection)).toBe('qzone');
      const scope = initialQzoneScope(selection);
      expect(scope).toEqual({ uin: '19999', tids: ['a', 'c'] });
      scope.tids!.push('b');
      expect(selection.scope.type === 'items' && selection.scope.ids).toEqual(['a', 'c', 'a']);
      expect(initialQzoneScope({ ...selection, scope: { type: 'items', ids: [] } })).toEqual({
        uin: '19999',
        tids: [],
      });
    });
    it('频道私聊按 nodeId 和离散消息身份复制，空集合不扩大为全部消息', () => {
      const selection: ContentSelection = {
        owner: { kind: 'guild-direct', container: '987654321' },
        scope: { type: 'items', ids: ['9007199254740993', '7', '7'] },
      };
      expect(initialExportMode(selection)).toBe('guild');
      const scope = initialGuildScope(selection);
      expect(scope).toEqual({
        nodeIds: ['987654321'],
        messageIds: { '987654321': ['9007199254740993', '7'] },
      });
      scope.messageIds['987654321']!.push('8');
      expect(selection.scope.type === 'items' && selection.scope.ids).toHaveLength(3);
      expect(initialGuildScope({ ...selection, scope: { type: 'items', ids: [] } })).toEqual({
        nodeIds: ['987654321'],
        messageIds: { '987654321': [] },
      });
    });
    it('联系人、多个群与精确群成员分别复制身份，不降级为全部好友', () => {
      const selection: ContentSelection = {
        owner: { kind: 'contacts', container: 'friends' },
        scope: { type: 'items', ids: ['a', 'c', 'a'] },
      };
      expect(initialExportMode(selection)).toBe('contacts');
      const friends = initialContactScope(selection);
      expect(friends.friendUids).toEqual(['a', 'c']);
      friends.friendUids!.push('new');
      expect(selection.scope.type === 'items' && selection.scope.ids).toEqual(['a', 'c', 'a']);
      expect(
        initialContactScope({
          owner: { kind: 'contacts', container: 'groups' },
          scope: { type: 'items', ids: ['10001', '10002'] },
        }),
      ).toEqual({ scope: 'group', groupIds: ['10001', '10002'], memberUids: {} });
      expect(
        initialContactScope({
          owner: { kind: 'contacts', container: 'group:10001' },
          scope: { type: 'items', ids: ['m1', 'm3'] },
        }),
      ).toEqual({ scope: 'group', groupIds: ['10001'], memberUids: { '10001': ['m1', 'm3'] } });
    });
    it('按已接入的内容种类进入流程', () => {
      for (const [kind, mode] of [
        ['collections', 'collection'],
        ['mail-messages', 'mail'],
        ['messages', 'full'],
        ['conversations', 'full'],
      ] as const) {
        expect(
          initialExportMode({ owner: { kind, container: 'fixture' }, scope: { type: 'all' } }),
        ).toBe(mode);
      }
    });
    it('会话多选和消息精确选择带入独立对象，不把虚拟会话交给真实消息导出', () => {
      const selection: ContentSelection = {
        owner: { kind: 'conversations', container: 'all' },
        scope: { type: 'items', ids: ['u_fixture', 'virtual:persona:p'] },
      };
      const ids = initialConversationIds(selection);
      expect(ids).toEqual(['u_fixture']);
      ids.push('另一对象');
      expect(selection.scope.type === 'items' && selection.scope.ids).toEqual([
        'u_fixture',
        'virtual:persona:p',
      ]);
      expect(
        initialConversationIds({
          owner: { kind: 'messages', container: 'c2c:u_fixture' },
          scope: { type: 'items', ids: ['1', '3'] },
        }),
      ).toEqual(['u_fixture']);
    });
  });
});

describe('tool_targets', () => {
  it('全局工具只取当前页面和会话的多选，不误用隐藏页面保留的选择', () => {
    const contacts: ContentSelection = {
      owner: { kind: 'contacts', container: 'friends' },
      scope: { type: 'items', ids: ['peer'] },
    };
    expect(
      selectionForWorkspace({ view: 'messages', conversation: group }, contacts),
    ).toBeUndefined();
    expect(selectionForWorkspace({ view: 'contacts' }, contacts)).toBe(contacts);
    expect(selectionForWorkspace({ view: 'settings' }, contacts)).toBeUndefined();
    const messages: ContentSelection = {
      owner: { kind: 'messages', container: `direct:${direct.id}` },
      scope: { type: 'items', ids: ['1'] },
    };
    expect(
      selectionForWorkspace({ view: 'messages', conversation: direct }, messages)?.owner.container,
    ).toBe(`c2c:${direct.id}`);
    expect(
      selectionForWorkspace({ view: 'messages', conversation: group }, messages),
    ).toBeUndefined();
  });

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
});
