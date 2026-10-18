import { describe, expect, it } from 'vitest';
import {
  initialContactScope,
  initialConversationIds,
  initialExportMode,
  initialGuildScope,
} from '../src/renderer/src/views/export/exportScope';
import type { ContentSelection } from '../src/shared/content_selection';

describe('统一导出的上下文草稿', () => {
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
