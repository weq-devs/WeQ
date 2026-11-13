// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  analysisTargetForWorkspace,
  defaultSelectionForContext,
  exportEntryForConversation,
  exportEntryForWorkspace,
  selectionForWorkspace,
  type WorkspaceContext,
} from '../src/renderer/src/lib/toolTargets';
import {
  conversationBatchTargets,
  generatedContentContainer,
  generatedContentIdentity,
  type ContentSelection,
} from '../src/shared/content_selection';
import type { Conversation } from '../src/renderer/src/im-template/template/types';

const previous: Conversation = {
  id: 'u_previous',
  type: 'direct',
  chatType: 1,
  otherUser: {
    id: 'u_previous',
    identityLabel: 'QQ',
    identityValue: '10001',
    username: '之前的好友',
    displayName: '之前的好友',
    avatarUrl: null,
  },
  group: null,
  members: [],
  updatedAt: '',
  lastMessage: null,
};
const previousMessages: ContentSelection = {
  owner: { kind: 'messages', container: 'direct:u_previous' },
  scope: { type: 'items', ids: ['previous-message'] },
};
const previousList: ContentSelection = {
  owner: { kind: 'conversations', container: 'main-list' },
  scope: { type: 'items', ids: ['u_previous'] },
};
const assistant: WorkspaceContext = {
  view: 'messages',
  conversation: previous,
  specialChat: 'assistant',
  assistantSessionId: 'session-current',
};
const guild: WorkspaceContext = {
  view: 'messages',
  conversation: previous,
  specialChat: 'guild',
  guildNodeId: 'current-node',
};

describe('主聊天区域工具目标', () => {
  it('助手和频道私聊优先于保留的旧QQ聊天，没有实际身份时也不回退旧QQ', () => {
    const entry = exportEntryForWorkspace(assistant);
    expect(entry.mode).toBe('generated');
    expect(generatedContentIdentity(entry.selection)).toEqual({
      kind: 'assistant',
      ownerId: 'assistant',
      sessionId: 'session-current',
    });
    expect(exportEntryForWorkspace(guild)).toMatchObject({
      mode: 'guild',
      selection: {
        owner: { kind: 'guild-direct', container: 'current-node' },
        scope: { type: 'all' },
      },
    });
    expect(exportEntryForWorkspace({ ...assistant, assistantSessionId: null })).toEqual({
      mode: 'generated',
      label: '导出 WeQ 助手会话',
    });
    expect(exportEntryForWorkspace({ ...guild, guildNodeId: null })).toEqual({
      mode: 'guild',
      label: '导出频道私聊',
    });
    expect(analysisTargetForWorkspace(assistant)).toBeNull();
    expect(analysisTargetForWorkspace(guild)).toBeNull();
  });

  it.each(['official', 'service'] as const)(
    '正在显示的%s始终使用真实数据源，不继承旧QQ会话',
    (kind) => {
      const ownerId = kind === 'official' ? 'u_official' : 'service-app';
      const rowId = kind === 'official' ? ownerId : `service:${ownerId}`;
      const ctx: WorkspaceContext = {
        view: 'messages',
        conversation: previous,
        officialFeed: { kind, conversationId: rowId, title: '当前推送账号' },
      };
      const entry = exportEntryForWorkspace(ctx);
      expect(entry.mode).toBe('full');
      expect(conversationBatchTargets(entry.selection!)).toEqual([
        { id: rowId, ownerId, kind, name: '当前推送账号' },
      ]);
      expect(analysisTargetForWorkspace(ctx)).toBeNull();
      expect(selectionForWorkspace(ctx, previousMessages)).toBeUndefined();
      expect(selectionForWorkspace(ctx, previousList)).toBeUndefined();
      expect(selectionForWorkspace(ctx, entry.selection!)).toEqual(entry.selection);
      if (kind === 'service') {
        expect(
          conversationBatchTargets(
            defaultSelectionForContext({
              ...ctx,
              officialFeed: { ...ctx.officialFeed!, conversationId: ownerId },
            })!,
          )[0]?.ownerId,
        ).toBe(ownerId);
      }
    },
  );

  it('精确生成选区必须匹配当前独立会话，旧QQ、克隆及其他助手选区均不借用', () => {
    const current: ContentSelection = {
      owner: {
        kind: 'assistant-messages',
        container: generatedContentContainer({
          kind: 'assistant',
          ownerId: 'assistant',
          sessionId: 'session-current',
        }),
      },
      scope: { type: 'items', ids: ['m1', 'm3'] },
    };
    expect(selectionForWorkspace(assistant, current)).toBe(current);
    for (const selection of [
      previousMessages,
      previousList,
      {
        ...current,
        owner: {
          ...current.owner,
          container: generatedContentContainer({
            kind: 'assistant',
            ownerId: 'assistant',
            sessionId: 'session-other',
          }),
        },
      },
      {
        ...current,
        owner: {
          kind: 'clone-messages' as const,
          container: generatedContentContainer({
            kind: 'persona',
            ownerId: 'clone',
            sessionId: null,
          }),
        },
      },
    ])
      expect(selectionForWorkspace(assistant, selection)).toBeUndefined();
  });

  it('频道精确消息只匹配当前node，其他频道、旧QQ和旧列表选区不参与', () => {
    const selected: ContentSelection = {
      owner: { kind: 'guild-direct', container: 'current-node' },
      scope: { type: 'items', ids: ['1', '7'] },
    };
    expect(selectionForWorkspace(guild, selected)).toBe(selected);
    expect(
      selectionForWorkspace(guild, {
        ...selected,
        owner: { ...selected.owner, container: 'other-node' },
      }),
    ).toBeUndefined();
    expect(selectionForWorkspace(guild, previousMessages)).toBeUndefined();
    expect(selectionForWorkspace(guild, previousList)).toBeUndefined();
    expect(
      selectionForWorkspace({ view: 'guild-direct', guildNodeId: 'current-node' }, selected),
    ).toBe(selected);
  });

  it('统一目录行的生成身份与特殊来源同样有效，正常QQ选区保持原有行为', () => {
    const generated: Conversation = {
      ...previous,
      id: 'assistant:row',
      generated: { kind: 'assistant', ownerId: 'assistant', sessionId: 'row' },
    };
    expect(
      generatedContentIdentity(exportEntryForConversation(generated)?.selection)?.sessionId,
    ).toBe('row');
    expect(analysisTargetForWorkspace({ view: 'messages', conversation: generated })).toBeNull();
    const channel: Conversation = { ...previous, id: 'guild:node', directoryKind: 'guild' };
    expect(exportEntryForConversation(channel)?.selection?.owner).toEqual({
      kind: 'guild-direct',
      container: 'node',
    });
    expect(analysisTargetForWorkspace({ view: 'messages', conversation: channel })).toBeNull();
    expect(selectionForWorkspace({ view: 'messages', conversation: previous }, previousList)).toBe(
      previousList,
    );
    expect(
      selectionForWorkspace({ view: 'messages', conversation: previous }, previousMessages)?.owner
        .container,
    ).toBe('c2c:u_previous');
  });
});
