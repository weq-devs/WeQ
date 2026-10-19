import { expect, it } from 'vitest';
import { findReplyPreview } from '../src/renderer/src/lib/replyPreview';

const text = { type: 'text', data: { textContent: '旧消息正文' } };
const source = {
  msgSeq: '120',
  clientSeq: '7',
  senderUin: '20002',
  sendTime: '1700000000',
  elements: [text, { type: 'reply' }],
};
it('旧引用摘要按正确编号恢复，并排除上一层引用', () => {
  expect(findReplyPreview('group', { origMsgSeq: 120 }, [source])).toEqual([text]);
  expect(findReplyPreview('c2c', { origClientSeq: 7, origSenderUin: 20002 }, [source])).toEqual([
    text,
  ]);
  expect(findReplyPreview('c2c', { origMsgIndex: 120 }, [source])).toEqual([text]);
  expect(findReplyPreview('c2c', { origMsgIndex: 7 }, [source])).toBeUndefined();
});
it('同一 client sequence 重号时必须消歧，不能显示另一人的内容', () => {
  const sources = [source, { ...source, msgSeq: '121', senderUin: '10001' }];
  expect(findReplyPreview('c2c', { origClientSeq: 7 }, sources)).toBeUndefined();
  expect(
    findReplyPreview(
      'c2c',
      { origClientSeq: 7, origSenderUin: 20002, origMsgTime: 1700000000 },
      sources,
    ),
  ).toEqual([text]);
  expect(
    findReplyPreview('c2c', { origClientSeq: 7, origMsgTime: 1700000001 }, sources),
  ).toBeUndefined();
});
