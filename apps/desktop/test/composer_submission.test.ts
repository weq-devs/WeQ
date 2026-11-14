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
    payloadBody: ' 正文 引用语音',
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

it.each([' ', '\n', '\n\n', ' \t\r\n', '\n 正文 \n'])('正文 %j 原样提交，不裁剪空白', (body) => {
  expect(composerSubmission({ body, singleToken: null, quoteToken: null })).toEqual({
    payloadBody: body,
    empty: false,
    clearsBody: true,
  });
});

it('只有引用补一个普通空格，真正空消息不可提交', () => {
  expect(composerSubmission({ body: '', singleToken: null, quoteToken: null }).empty).toBe(true);
  expect(composerSubmission({ body: '', singleToken: null, quoteToken: '引用' })).toEqual({
    payloadBody: ' 引用',
    empty: false,
    clearsBody: true,
  });
  expect(
    composerSubmission({ body: '\n ', singleToken: null, quoteToken: '引用' }).payloadBody,
  ).toBe('\n 引用');
});

it('引用带附件或额外元素时不补空格，忽略引用的独立操作仍不可空发', () => {
  expect(
    composerSubmission({ body: '', singleToken: '附件', quoteToken: '引用' }).payloadBody,
  ).toBe('引用附件');
  expect(
    composerSubmission({
      body: '',
      singleToken: null,
      quoteToken: '引用',
      options: { extraTokens: ['元素'] },
    }).payloadBody,
  ).toBe('引用元素');
  expect(
    composerSubmission({
      body: '',
      singleToken: null,
      quoteToken: '引用',
      options: { omitQuote: true },
    }).empty,
  ).toBe(true);
});
