import { expect, it } from 'vitest';
import { matchesMessageFilter, messageCategory } from '../src/account/message_filter';
import type { RenderElement } from '../src/account/msg_view';

const message = {
  senderUid: 'u_alice',
  senderUin: 123n,
  elements: [
    { type: 'text', data: { textContent: 'Hello project' } },
    { type: 'pic', data: { fileName: 'test.png' } },
  ] as RenderElement[],
};
it('matches all combined predicates, not any one predicate', () => {
  expect(
    matchesMessageFilter(message, { sender: '123', keyword: 'HELLO', category: 'image' }),
  ).toBe(true);
  expect(
    matchesMessageFilter(message, { sender: 'u_alice', keyword: 'Hello', category: 'voice' }),
  ).toBe(false);
  expect(matchesMessageFilter(message, { sender: 'u_other', keyword: 'Hello' })).toBe(false);
  expect(matchesMessageFilter(message, { keyword: 'absent' })).toBe(false);
});
it('mixed-content messages belong to each actual category', () => {
  expect(messageCategory(message.elements)).toEqual(['text', 'image']);
  expect(messageCategory([])).toEqual(['other']);
  expect(messageCategory([{ type: 'grayTipPoke', data: {} }] as RenderElement[])).toEqual([
    'system',
  ]);
});

it('精确间断选择只接受指定消息，大 ID 不转成浮点数，空选不等于全部', () => {
  const selected = { messageIds: ['9007199254740993', '9007199254740995'] };
  expect(matchesMessageFilter({ ...message, msgId: 9007199254740993n }, selected)).toBe(true);
  expect(matchesMessageFilter({ ...message, msgId: 9007199254740994n }, selected)).toBe(false);
  expect(matchesMessageFilter({ ...message, msgId: 9007199254740995n }, selected)).toBe(true);
  expect(matchesMessageFilter({ ...message, msgId: '9007199254740993' }, { messageIds: [] })).toBe(
    false,
  );
  expect(matchesMessageFilter(message, selected)).toBe(false);
});

it('同一个数值 ID 的本地消息和漫游变体按精确来源区分', () => {
  const selected = { messageIds: ['roaming:protocol:8:9007199254740993'] };
  expect(matchesMessageFilter({ ...message, msgId: '9007199254740993' }, selected)).toBe(false);
  expect(
    matchesMessageFilter(
      {
        ...message,
        msgId: '9007199254740993',
        msgSeq: 8n,
        source: 'roaming',
        sourceFormat: 'protocol',
      },
      selected,
    ),
  ).toBe(true);
  expect(
    matchesMessageFilter(
      {
        ...message,
        msgId: '9007199254740993',
        msgSeq: 8n,
        source: 'roaming',
        sourceFormat: 'native',
      },
      selected,
    ),
  ).toBe(false);
});
