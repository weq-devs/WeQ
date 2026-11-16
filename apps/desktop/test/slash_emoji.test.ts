import { describe, expect, it } from 'vitest';
import { searchSlashEmojis, slashEmojiTrigger } from '@renderer/lib/slashEmoji';

describe('斜杠表情匹配', () => {
  it('匹配空关键词、正文中间及新行，不要求前置空格', () => {
    expect(slashEmojiTrigger('/')).toEqual({ start: 0, end: 1, query: '' });
    expect(slashEmojiTrigger('你好/微笑')).toEqual({ start: 2, end: 5, query: '微笑' });
    expect(slashEmojiTrigger('上一行\n/笑')).toEqual({ start: 4, end: 6, query: '笑' });
  });
  it.each([
    'https://example.com/笑',
    'https://',
    'example.com/笑',
    '/home/user/笑',
    'C:\\temp/笑',
    '~/笑',
    './笑',
    '../笑',
    '/笑\n',
    '/笑 ',
  ])('不触发 URL、路径及跨行片段 %s', (text) => {
    expect(slashEmojiTrigger(text)).toBeNull();
  });
  it('名称精确、前缀、包含依次排序；空词使用最近记录', () => {
    const faces = [
      { id: '1', desc: '[微笑]' },
      { id: '2', desc: '/笑' },
      { id: '3', desc: '[笑哭]' },
    ];
    expect(
      searchSlashEmojis(faces, [{ id: '1', usedAt: 10 }], '笑').map((item) => item.id),
    ).toEqual(['2', '3', '1']);
    expect(searchSlashEmojis(faces, [{ id: '3', usedAt: 20 }], '').map((item) => item.id)).toEqual([
      '3',
      '1',
      '2',
    ]);
    expect(searchSlashEmojis([{ id: '9', desc: '/打Call' }], [], 'call')).toHaveLength(1);
  });
});
