// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  selectMessageIds,
  selectedMessagesText,
  isLocalOutgoingMessage,
  outgoingActionBlockReason,
  mergeSelectionGaps,
  type SelectionGap,
} from '../src/renderer/src/lib/messageSelection';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { createSelectionGapIndex } from '../src/renderer/src/lib/selectionGapIndex';

describe('message_selection', () => {
  describe('消息快速多选', () => {
    it('缺口区间重叠时合并计数，不把两处缺口之间的真实消息也计入', () => {
      const gaps = [
        { previousSeq: '1', currentSeq: '5', count: 3 },
        { previousSeq: '3', currentSeq: '8', count: 4 },
      ];
      expect(mergeSelectionGaps(gaps)).toEqual([{ previousSeq: '1', currentSeq: '8', count: 6 }]);
      expect(gaps[0]?.currentSeq).toBe('5');
      expect(
        mergeSelectionGaps([gaps[0]!, { previousSeq: '5', currentSeq: '9', count: 3 }]),
      ).toHaveLength(2);
    });
    const ids = ['a', 'b', 'c', 'd', 'e'];
    it('Ctrl/⌘ 切换单条，不丢失已选项', () => {
      expect([...selectMessageIds(new Set(['a']), ids, 'c', 'a', { ctrlKey: true })]).toEqual([
        'a',
        'c',
      ]);
      expect([...selectMessageIds(new Set(['a', 'c']), ids, 'c', 'a', { metaKey: true })]).toEqual([
        'a',
      ]);
    });
    it('Shift 支持正反向区间、收缩与 Ctrl+Shift 追加', () => {
      expect([...selectMessageIds(new Set(['e']), ids, 'd', 'b', { shiftKey: true })]).toEqual([
        'b',
        'c',
        'd',
      ]);
      expect([...selectMessageIds(new Set(['e']), ids, 'b', 'd', { shiftKey: true })]).toEqual([
        'b',
        'c',
        'd',
      ]);
      expect([...selectMessageIds(new Set(ids), ids, 'c', 'b', { shiftKey: true })]).toEqual([
        'b',
        'c',
      ]);
      expect([
        ...selectMessageIds(new Set(['a']), ids, 'e', 'd', { shiftKey: true, ctrlKey: true }),
      ]).toEqual(['a', 'd', 'e']);
    });
    it('锚点已不在当前窗口时只选当前条，且区间没有条数上限', () => {
      expect([...selectMessageIds(new Set(), ids, 'c', 'missing', { shiftKey: true })]).toEqual([
        'c',
      ]);
      const many = Array.from({ length: 5000 }, (_, index) => String(index));
      expect(selectMessageIds(new Set(), many, '4999', '0', { shiftKey: true }).size).toBe(5000);
    });
  });

  describe('所选消息纯文本', () => {
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((item) => item.type === 'group')!;
    const message = {
      ...demo.messages[0]!,
      senderId: demo.user.id,
      createdAt: '2026-10-16T17:02:03Z',
      body: '第一行\n第二行',
    };
    it('保留昵称、北京时间秒级时间、正文换行及消息顺序', () => {
      const text = selectedMessagesText(
        [message, { ...message, id: 'second', body: '另一条' }],
        conversation,
        demo.user,
      );
      expect(text).toContain(`${demo.user.displayName} (2026-10-17 01:02:03)\n第一行\n第二行`);
      expect(text.endsWith('另一条')).toBe(true);
      expect(text).not.toContain('"createdAt"');
    });
    it('媒体使用已有预览标签，非法时间不伪造日期', () => {
      const media = {
        ...message,
        createdAt: 'bad',
        body: '',
        qqElements: [{ type: 'pic', data: {} }],
      };
      expect(selectedMessagesText([media], conversation, demo.user)).toContain(
        '(时间未知)\n[图片]',
      );
    });
    it('未入库消息可打开只读菜单，协议动作区分发送中、失败与成功', () => {
      expect(isLocalOutgoingMessage({ ...message, id: 'optimistic-1' })).toBe(true);
      expect(outgoingActionBlockReason({ ...message, optimistic: 'sending' })).toBeTruthy();
      expect(outgoingActionBlockReason({ ...message, optimistic: 'failed' })).toBeTruthy();
      expect(
        outgoingActionBlockReason({ ...message, optimistic: 'sent', optimisticRejected: true }),
      ).toBeTruthy();
      expect(outgoingActionBlockReason({ ...message, optimistic: 'sent' })).toBeNull();
    });
  });
});

describe('selection_gap_index', () => {
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
        input.some(
          (row) => BigInt(row.previousSeq) < sequence && BigInt(row.currentSeq) > sequence,
        ),
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
});
