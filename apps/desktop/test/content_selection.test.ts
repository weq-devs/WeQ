import { describe, expect, it } from 'vitest';
import {
  createToolDraft,
  freezeToolTarget,
  reduceContentSelection,
  type ContentSelection,
} from '../src/shared/content_selection';

const chat = { kind: 'messages', container: 'group:fixture' } as const;
const otherChat = { kind: 'messages', container: 'c2c:fixture' } as const;
const collection = { kind: 'collections', container: 'all' } as const;

describe('内容选择与工具草稿', () => {
  it('另一处开始多选替换旧集合，同一处切换单条且保留顺序', () => {
    const first = reduceContentSelection(null, { type: 'select', owner: chat, ids: ['1', '3'] });
    const next = reduceContentSelection(first, { type: 'toggle', owner: chat, id: '5' });
    expect(next?.scope).toEqual({ type: 'items', ids: ['1', '3', '5'] });
    expect(reduceContentSelection(next, { type: 'toggle', owner: chat, id: '3' })?.scope).toEqual({
      type: 'items',
      ids: ['1', '5'],
    });
    expect(reduceContentSelection(next, { type: 'toggle', owner: otherChat, id: '8' })).toEqual({
      owner: otherChat,
      scope: { type: 'items', ids: ['8'] },
    });
    expect(reduceContentSelection(next, { type: 'select', owner: collection, ids: ['c'] })).toEqual(
      {
        owner: collection,
        scope: { type: 'items', ids: ['c'] },
      },
    );
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
