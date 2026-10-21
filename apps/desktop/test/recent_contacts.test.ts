import { expect, it } from 'vitest';
import { mergeRecentContactPages } from '../src/renderer/src/lib/recentContacts';

it('分页重叠保留最新副本，64 位序号不丢精度，同水位优先最新页', () => {
  const fresh = { targetUid: 'peer', msgSeq: '9007199254740993', sendTime: '200', body: '新预览' };
  const old = { ...fresh, msgSeq: '9007199254740992', sendTime: '100', body: '旧预览' };
  expect(mergeRecentContactPages([[fresh], [old]])).toEqual([fresh]);
  expect(mergeRecentContactPages([[old], [fresh]])).toEqual([fresh]);
  expect(mergeRecentContactPages([[fresh], [{ ...fresh, body: '旧分页' }]])).toEqual([fresh]);
});
