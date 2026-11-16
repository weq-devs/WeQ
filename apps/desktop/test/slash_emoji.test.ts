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
  it('只匹配前缀，按代码字典序排列', () => {
    const faces = [
      { id: '1', desc: '[微笑]' },
      { id: '2', desc: '/笑脸' },
      { id: '3', desc: '[笑哭]' },
    ];
    expect(searchSlashEmojis(faces, '笑').map((item) => item.id)).toEqual(['3', '2']);
    expect(searchSlashEmojis(faces, '').map((item) => item.id)).toEqual(['1', '3', '2']);
    expect(searchSlashEmojis([{ id: '9', desc: '/打Call' }], 'call')).toEqual([]);
  });
  it('QQ 实际英文短码可匹配，不把 bx 当作比心，也不擅自补全拼', () => {
    const faces = [
      { id: '297', desc: '/拜谢', shortcuts: ['bx'] },
      { id: '319', desc: '/比心', shortcuts: [] },
      { id: '182', desc: '/笑哭', shortcuts: ['xk'] },
      { id: '361', desc: '/狗狗笑哭', shortcuts: [] },
      { id: '14', desc: '/微笑', shortcuts: ['wx', ':)'] },
    ];
    expect(searchSlashEmojis(faces, 'bx').map((item) => item.id)).toEqual(['297']);
    expect(searchSlashEmojis(faces, 'XK')[0]?.id).toBe('182');
    expect(searchSlashEmojis(faces, 'xiaoku')).toEqual([]);
    expect(searchSlashEmojis(faces, 'wx')[0]?.id).toBe('14');
    expect(searchSlashEmojis(faces, '笑哭').map((item) => item.id)).toEqual(['182']);
  });
  it('显示当前命中的别名，多个前缀别名也按字典序选择', () => {
    const faces = [
      { id: '76', desc: '/赞', shortcuts: ['qiang', 'strong'] },
      { id: '77', desc: '/太阳', shortcuts: ['sun', 'solar'] },
    ];
    expect(searchSlashEmojis(faces, 'STRONG')).toMatchObject([{ id: '76', code: 'strong' }]);
    expect(searchSlashEmojis(faces, 'qi')).toMatchObject([{ id: '76', code: 'qiang' }]);
    expect(searchSlashEmojis(faces, '赞')).toMatchObject([{ id: '76', code: '赞' }]);
    expect(searchSlashEmojis(faces, 's')).toMatchObject([
      { id: '77', code: 'solar' },
      { id: '76', code: 'strong' },
    ]);
    expect(searchSlashEmojis(faces, 'ron')).toEqual([]);
    expect(faces[0]?.shortcuts).toEqual(['qiang', 'strong']);
  });
  it('过滤非法表情，重复表情只显示一次', () => {
    expect(
      searchSlashEmojis(
        [
          { id: 'not-a-face', desc: '/smile' },
          { id: '1', desc: '/smile' },
          { id: '1', desc: '/smile' },
        ],
        's',
      ),
    ).toMatchObject([{ id: '1', code: 'smile' }]);
  });
});
