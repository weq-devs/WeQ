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
