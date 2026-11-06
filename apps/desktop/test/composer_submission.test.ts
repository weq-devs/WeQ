// @vitest-environment node
import { expect, it } from 'vitest';
import { composerSubmission } from '../src/renderer/src/im-template/template/composerSubmission';

it('正文、引用和额外 token 按原有顺序交接，保留原始输入快照', () => {
  const input = {
    body: ' 正文 ',
    singleToken: null,
    quoteToken: '引用',
    options: { extraTokens: ['语音'] },
  };
  expect(composerSubmission(input)).toEqual({
    payloadBody: '正文引用语音',
    empty: false,
    clearsBody: true,
  });
  expect(input.body).toBe(' 正文 ');
});

it('单独发送附件保留正文；独立命令可以排除引用并保留草稿', () => {
  expect(composerSubmission({ body: '保留草稿', singleToken: '附件', quoteToken: null })).toEqual({
    payloadBody: '附件',
    empty: false,
    clearsBody: false,
  });
  expect(
    composerSubmission({
      body: '保留草稿',
      singleToken: null,
      quoteToken: '引用',
      options: { text: '独立命令', omitQuote: true, keepBody: true },
    }),
  ).toEqual({ payloadBody: '独立命令', empty: false, clearsBody: false });
});

it('空白正文不可提交，只有引用或额外 token 仍是有效内容', () => {
  expect(composerSubmission({ body: ' \n', singleToken: null, quoteToken: null }).empty).toBe(true);
  expect(composerSubmission({ body: '', singleToken: null, quoteToken: '引用' }).empty).toBe(false);
});
