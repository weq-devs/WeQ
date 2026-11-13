import { expect, it } from 'vitest';
import { reconcileResolvedRows } from '../src/renderer/src/lib/resolvedRows';

it('空批次、被版本过滤的批次和嵌套等值 wire 都保留原索引', () => {
  const previous = { u_a: { uid: 'u_a', card: '甲', labels: ['一'], meta: { level: 2 } } };
  expect(reconcileResolvedRows(previous, [])).toBe(previous);
  expect(reconcileResolvedRows(previous, [{ ...previous.u_a, card: '旧' }], () => false)).toBe(
    previous,
  );
  expect(reconcileResolvedRows(previous, structuredClone(Object.values(previous)))).toBe(previous);
});

it('只替换实际变化的行与字段，完整替换允许移除属性，不修改原输入', () => {
  const first = { uid: 'u_a', card: '甲', labels: ['一'], meta: { level: 2 }, oldTitle: '旧头衔' };
  const second = { uid: 'u_b', card: '乙', labels: [], meta: { level: 1 } };
  const previous = Object.freeze({ u_a: Object.freeze(first), u_b: Object.freeze(second) });
  const next = reconcileResolvedRows<{
    uid: string;
    card: string;
    labels: string[];
    meta: { level: number };
    oldTitle?: string;
  }>(previous, [
    { uid: 'u_a', card: '', labels: ['一'], meta: { level: 3 } },
    structuredClone(second),
  ]);
  expect(next).not.toBe(previous);
  expect(next.u_a.card).toBe('');
  expect(next.u_a.labels).toBe(first.labels);
  expect(next.u_a).not.toHaveProperty('oldTitle');
  expect(next.u_b).toBe(second);
  expect(previous.u_a.card).toBe('甲');
});

it('同 UID 仍按最后一个有效快照替换，过滤不影响其他行', () => {
  const previous = { u_a: { uid: 'u_a', card: '甲' } };
  const next = reconcileResolvedRows(
    previous,
    [
      { uid: 'u_a', card: '第一份' },
      { uid: 'u_b', card: '忽略' },
      { uid: 'u_a', card: '最后一份' },
    ],
    (row) => row.uid === 'u_a',
  );
  expect(next.u_a.card).toBe('最后一份');
  expect(next).not.toHaveProperty('u_b');
});
