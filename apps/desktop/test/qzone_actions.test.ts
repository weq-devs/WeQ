import { expect, it } from 'vitest';
import { QzoneRelatedRound, qzoneForwardDraft } from '../src/renderer/src/lib/qzoneActions';

it('引用上一人文案，保留原始文字；关闭或无文案时不预填', () => {
  expect(qzoneForwardDraft(true, '上一人\n文案')).toBe('//：上一人\n文案');
  expect(qzoneForwardDraft(false, '文案')).toBe('');
  expect(qzoneForwardDraft(true, '  ')).toBe('');
});

it('每轮最多五次，未用完的滚动不叠加额度，耗尽后只有向下滚动重开', () => {
  const round = new QzoneRelatedRound();
  expect(round.take()).toBe(true);
  expect(round.scrollDown()).toBe(false);
  for (let index = 1; index < round.limit; index++) expect(round.take()).toBe(true);
  expect(round.take()).toBe(false);
  expect(round.take()).toBe(false);
  expect(round.scrollDown()).toBe(true);
  for (let index = 0; index < round.limit; index++) expect(round.take()).toBe(true);
  expect(round.take()).toBe(false);
});
