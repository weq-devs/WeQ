import { expect, it } from 'vitest';
import { qzoneTextParts } from '../src/renderer/src/lib/qzone';

it('原生 @ 昵称转义只解码一次，保留定位及正文偏移', () => {
  expect(qzoneTextParts('前@{uin:10001,nick:%25%2C%7B%7D}后')).toEqual([
    { kind: 'text', text: '前', offset: 0 },
    { kind: 'mention', uin: '10001', text: '@%,{}', offset: 1 },
    { kind: 'text', text: '后', offset: 31 },
  ]);
  expect(qzoneTextParts('@{uin:10001,nick:%252C}')[0]).toMatchObject({ text: '@%2C' });
});
it('未转义的百分号、普通中文和表情仍能正常显示', () => {
  expect(qzoneTextParts('@{uin:10001,nick:100%}')[0]).toMatchObject({ text: '@100%' });
  expect(qzoneTextParts('正文[em]e100[/em]')).toEqual([
    { kind: 'text', text: '正文', offset: 0 },
    { kind: 'emoji', code: 'e100', offset: 2 },
  ]);
});
