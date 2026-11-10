// @vitest-environment node
import { expect, it } from 'vitest';
import {
  mergeRecentContactPages,
  recentContactPreviewIsBehind,
} from '../src/renderer/src/lib/recentContacts';

it('正文校准比较时间和同秒序号，不因旧历史、未对账漫游或发送摘要反复刷新', () => {
  const summary = { targetUid: 'peer', msgSeq: '9007199254740992', sendTime: '200' };
  expect(recentContactPreviewIsBehind(summary, { msgSeq: '1', sendTime: '201' })).toBe(true);
  expect(
    recentContactPreviewIsBehind(summary, { msgSeq: '9007199254740993', sendTime: '200' }),
  ).toBe(true);
  expect(recentContactPreviewIsBehind(summary, summary)).toBe(false);
  expect(
    recentContactPreviewIsBehind(summary, { msgSeq: '9007199254740993', sendTime: '199' }),
  ).toBe(false);
  expect(
    recentContactPreviewIsBehind(summary, { msgSeq: '9007199254740991', sendTime: '200' }),
  ).toBe(false);
  expect(
    recentContactPreviewIsBehind(summary, { msgSeq: '2', sendTime: '201', source: 'roaming' }),
  ).toBe(false);
});

it('分页重叠保留最新副本，64 位序号不丢精度，同水位优先最新页', () => {
  const fresh = { targetUid: 'peer', msgSeq: '9007199254740993', sendTime: '200', body: '新预览' };
  const old = { ...fresh, msgSeq: '9007199254740992', sendTime: '100', body: '旧预览' };
  expect(mergeRecentContactPages([[fresh], [old]])).toEqual([fresh]);
  expect(mergeRecentContactPages([[old], [fresh]])).toEqual([fresh]);
  expect(mergeRecentContactPages([[fresh], [{ ...fresh, body: '旧分页' }]])).toEqual([fresh]);
});
