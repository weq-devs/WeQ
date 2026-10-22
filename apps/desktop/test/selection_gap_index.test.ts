import { expect, it } from 'vitest';
import { createSelectionGapIndex } from '../src/renderer/src/lib/selectionGapIndex';
import type { SelectionGap } from '../src/renderer/src/lib/messageSelection';

const gap = (start: bigint, end: bigint): SelectionGap => ({
  previousSeq: String(start),
  currentSeq: String(end),
  count: Number(end - start - 1n),
});
it('空索引与开区间边界；包含整段必须来自某一个原始区间而非拼接', () => {
  expect(createSelectionGapIndex([]).containsSequence(5n)).toBe(false);
  const index = createSelectionGapIndex([gap(1n, 5n), gap(4n, 8n)]);
  expect(index.containsGap(gap(2n, 7n))).toBe(false);
  expect(index.containsGap(gap(1n, 5n))).toBe(true);
  expect(index.containsGap(gap(5n, 7n))).toBe(true);
  expect(index.containsSequence(1n)).toBe(false);
  expect(index.containsSequence(5n)).toBe(true);
  expect(index.containsSequence(8n)).toBe(false);
});
it('乱序、重复、嵌套、同起点与超过安全整数的区间查询与原始扫描一致', () => {
  const base = 18_446_744_073_709_000_000n;
  const gaps = Array.from({ length: 120 }, (_, i) =>
    gap(base + BigInt((i * 17) % 89), base + BigInt(((i * 17) % 89) + (i % 30) + 2)),
  );
  const input = [gap(base, base + 300n), ...gaps, ...gaps.slice(0, 5)].reverse();
  const index = createSelectionGapIndex(input);
  for (let offset = -1; offset <= 301; offset++) {
    const sequence = base + BigInt(offset);
    expect(index.containsSequence(sequence)).toBe(
      input.some((row) => BigInt(row.previousSeq) < sequence && BigInt(row.currentSeq) > sequence),
    );
    for (const width of [2n, 5n, 50n, 301n]) {
      const candidate = gap(sequence, sequence + width);
      expect(index.containsGap(candidate)).toBe(
        input.some(
          (row) =>
            BigInt(row.previousSeq) <= sequence && BigInt(row.currentSeq) >= sequence + width,
        ),
      );
    }
  }
});
it('快照建立后查询不重新遍历源区间，源对象后续修改不改变索引', () => {
  let reads = 0;
  const gaps = Array.from({ length: 2000 }, (_, i) => ({
    get previousSeq() {
      reads++;
      return String(i * 4 + 1);
    },
    get currentSeq() {
      reads++;
      return String(i * 4 + 4);
    },
    count: 2,
  }));
  const index = createSelectionGapIndex(gaps);
  expect(reads).toBe(4000);
  reads = 0;
  for (let i = 0; i < gaps.length; i++)
    expect(index.containsSequence(BigInt(i * 4 + 2))).toBe(true);
  expect(reads).toBe(0);
  const mutable = gap(1n, 5n),
    frozen = createSelectionGapIndex([mutable]);
  mutable.currentSeq = '3';
  expect(frozen.containsSequence(4n)).toBe(true);
});
