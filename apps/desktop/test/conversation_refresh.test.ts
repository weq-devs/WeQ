import { expect, it } from 'vitest';
import { mergeRefreshedWindow } from '../src/renderer/src/lib/conversationRefresh';

const rows = (start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, i) => ({
    msgSeq: String(start + i),
    msgId: String(start + i),
    body: 'before',
  }));

it('未变行及整个未变窗口保留引用，修改只替换对应行且删除仍生效', () => {
  const current = rows(1, 3).map((row) => ({ ...row, elements: [{ text: 'body' }] }));
  const fresh = structuredClone(current);
  expect(mergeRefreshedWindow(current, fresh, 50)).toBe(current);
  fresh[1]!.elements[0]!.text = 'edited';
  const changed = mergeRefreshedWindow(current, fresh, 50);
  expect(changed[0]).toBe(current[0]);
  expect(changed[1]).not.toBe(current[1]);
  expect(changed[2]).toBe(current[2]);
  expect(mergeRefreshedWindow(current, fresh.slice(1), 50)).toHaveLength(2);
});

it('中间补入、删除和向前补齐后，未变消息仍按稳定 ID 复用，不按数组位置重建', () => {
  const all = rows(1, 5).map((row) => ({ ...row, elements: [{ text: row.msgId }] }));
  const current = [all[1]!, all[3]!, all[4]!];
  const inserted = mergeRefreshedWindow(current, structuredClone(all.slice(1)), 50);
  expect(inserted[0]).toBe(current[0]);
  expect(inserted[2]).toBe(current[1]);
  expect(inserted[3]).toBe(current[2]);
  const removed = mergeRefreshedWindow(inserted, structuredClone(all.slice(3)), 50);
  expect(removed[0]).toBe(current[1]);
  expect(removed[1]).toBe(current[2]);
  const prepended = mergeRefreshedWindow(current, structuredClone(all), 50);
  expect(prepended[1]).toBe(current[0]);
  expect(prepended[3]).toBe(current[1]);
  expect(prepended[4]).toBe(current[2]);
  const capped = mergeRefreshedWindow(current, structuredClone(all.slice(2)), 3);
  expect(capped[0]).toBe(current[0]);
  expect(capped[2]).toBe(current[1]);
  expect(capped[3]).toBe(current[2]);
});

it('刷新达到上限时保留此前已加载的历史，不能被最新 500 条裁走', () => {
  const current = rows(1, 1000);
  const fresh = rows(502, 1001);
  const merged = mergeRefreshedWindow(current, fresh, 500);
  expect(merged).toHaveLength(1001);
  expect(merged[0]?.msgSeq).toBe('1');
  expect(merged.at(-1)?.msgSeq).toBe('1001');
});
it('保留历史但仍更新覆盖范围内的修改和删除，不把旧记录重新合回去', () => {
  const current = rows(1, 10);
  const fresh = rows(7, 11)
    .filter((row) => row.msgSeq !== '8')
    .map((row) => ({ ...row, body: 'updated' }));
  const merged = mergeRefreshedWindow(current, fresh, 4);
  expect(merged.map((row) => row.msgSeq)).toEqual([
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '9',
    '10',
    '11',
  ]);
  expect(merged.find((row) => row.msgSeq === '7')?.body).toBe('updated');
});
it('同 seq 的灰条在分页边界不能被误删或重复', () => {
  const current = [
    { msgId: 'one', msgSeq: '5' },
    { msgId: 'gray', msgSeq: '5' },
  ];
  const fresh = [
    { msgId: 'gray', msgSeq: '5' },
    { msgId: 'new', msgSeq: '6' },
  ];
  expect(mergeRefreshedWindow(current, fresh, 2).map((row) => row.msgId)).toEqual([
    'one',
    'gray',
    'new',
  ]);
});
it('未截断的完整刷新仍替换整个窗口，空结果不能保留已删除消息', () => {
  const current = rows(1, 3);
  const fresh = rows(2, 3);
  expect(mergeRefreshedWindow(current, fresh, 500)).toEqual(fresh);
  expect(mergeRefreshedWindow(current, [], 500)).toEqual([]);
});
