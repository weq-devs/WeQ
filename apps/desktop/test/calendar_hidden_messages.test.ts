import { expect, it } from 'vitest';
import { calendarTargetsWithHiddenMessages } from '../src/renderer/src/lib/calendarHiddenMessages';
import type { CalendarTarget } from '@weq/service/conversation-calendar';

it('克隆本地隐藏按对象和子会话隔离，坏记录不影响其他会话', async () => {
  const targets: CalendarTarget[] = [
    { kind: 'persona', conv: 'owner', name: '', avatar: null, ancestors: [] },
    { kind: 'cloneGroup', conv: 'owner', name: '', avatar: null, ancestors: [] },
  ];
  const data = new Map([
    ['chat-template.hiddenMessages.virtual:clone:persona:owner:bad', '{'],
    ['chat-template.hiddenMessages.virtual:clone:persona:owner:draft', '["legacy"]'],
    ['chat-template.hiddenMessages.virtual:clone:persona:owner:session', '["id",null,3]'],
    ['chat-template.hiddenMessages.virtual:clone:group:owner:session', '["group-id"]'],
    ['chat-template.hiddenMessages.virtual:clone:persona:other:session', '["other"]'],
  ]);
  const storage = {
    length: data.size,
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
  };
  const result = await calendarTargetsWithHiddenMessages(targets, storage);
  expect(result[0]?.hiddenIds).toEqual({ draft: ['legacy'], session: ['id'] });
  expect(result[1]?.hiddenIds).toEqual({ session: ['group-id'] });
  expect(targets[0]?.hiddenIds).toBeUndefined();
});
