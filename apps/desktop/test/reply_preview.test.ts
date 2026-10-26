import { expect, it } from 'vitest';
import { createReplyPreviewIndex, findReplyPreview } from '../src/renderer/src/lib/replyPreview';

it('两千条引用只建立一次索引，重复序号仍按发送者和时间消歧', () => {
  let reads = 0;
  const rows = Array.from({ length: 2000 }, (_, i) => ({
    get msgSeq() {
      reads++;
      return String(i + 1);
    },
    senderUin: '1',
    sendTime: '2',
    elements: [{ type: 'text', value: i }],
  }));
  const index = createReplyPreviewIndex(rows);
  for (let i = 0; i < rows.length; i++)
    expect(findReplyPreview('group', { origMsgSeq: i + 1 }, index)).toBeDefined();
  expect(reads).toBeLessThanOrEqual(4000);
  const duplicate = createReplyPreviewIndex([
    { msgSeq: '1', senderUin: '1', sendTime: '2', elements: ['a'] },
    { msgSeq: '1', senderUin: '2', sendTime: '2', elements: ['b'] },
  ]);
  expect(findReplyPreview('group', { origMsgSeq: 1 }, duplicate)).toBeUndefined();
  expect(findReplyPreview('group', { origMsgSeq: 1, origSenderUin: 2 }, duplicate)).toEqual(['b']);
});

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
