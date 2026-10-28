import { expect, it } from 'vitest';
import { applyReplyMedia, needsReplyMedia } from '../src/renderer/src/lib/replyMedia';

const row = () => ({
  msgId: '1',
  elements: [
    { type: 'reply', data: { origElements: [{ type: 'text', data: { textContent: '[图片]' } }] } },
  ],
});
const patches = [{ msgId: '1', elements: [{ type: 'pic', data: { elementId: 8n } }] }];

it('引用媒体按消息对象版本后补，不修改正文快照和未变化行', () => {
  const original = row();
  const other = { msgId: '2', elements: [] };
  const rows = [original, other];
  const next = applyReplyMedia(rows, new Map([['1', original]]), patches);
  expect(next).not.toBe(rows);
  expect(next[1]).toBe(other);
  expect(needsReplyMedia(original)).toBe(true);
  expect(needsReplyMedia(next[0]!)).toBe(false);
  expect(applyReplyMedia(next, new Map([['1', original]]), patches)).toBe(next);
});

it('迟到结果不覆盖编辑或删除后的对象，漫游来源不按本地 ID 猜引用', () => {
  const original = row();
  const edited = { ...original, elements: [] };
  const rows = [edited];
  expect(applyReplyMedia(rows, new Map([['1', original]]), patches)).toBe(rows);
  expect(needsReplyMedia({ ...original, source: 'roaming' })).toBe(false);
  expect(needsReplyMedia({ ...original, msgId: 'not-local' })).toBe(false);
});
