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

it('链接分类识别正文网址与链接卡片，并排除邮件地址、文件名及其他卡片', () => {
  const text = (value: string): RenderElement => ({ type: 'text', data: { textContent: value } });
  const card = (meta: object): RenderElement => ({
    type: 'ark',
    data: { arkData: JSON.stringify({ app: 'com.tencent.mobileqq.structmsg', meta }) },
  });
  const fixtures = [
    { elements: [text('阅读 https://example.com/ref 后回复')], linked: true },
    {
      elements: [text('可浏览 example.com/ref ，并且有配图。'), message.elements[1]!],
      linked: true,
    },
    { elements: [card({ news: { jumpUrl: 'https://example.com/page' } })], linked: true },
    { elements: [text('联系 friend@example.com，参考 README.md')], linked: false },
    { elements: [card({ news: { preview: 'https://example.com/thumb.png' } })], linked: false },
    { elements: [card({ news: { jumpUrl: 'file:///local' } })], linked: false },
    { elements: [card({ miniapp: { url: 'https://example.com/miniapp' } })], linked: false },
  ];
  for (const { elements, linked } of fixtures) {
    expect(matchesMessageFilter({ ...message, elements }, { category: 'link' })).toBe(linked);
    expect(messageCategory(elements).includes('link')).toBe(linked);
  }
  const withLink = { ...message, elements: fixtures[0]!.elements };
  expect(matchesMessageFilter(withLink, { category: 'text' })).toBe(true);
  expect(matchesMessageFilter(withLink, { category: 'link', sender: 'u_other' })).toBe(false);
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
