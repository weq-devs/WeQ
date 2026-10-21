import { describe, expect, it } from 'vitest';
import {
  selectMessageIds,
  selectedMessagesText,
  isLocalOutgoingMessage,
  outgoingActionBlockReason,
  mergeSelectionGaps,
} from '../src/renderer/src/lib/messageSelection';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

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
    expect(selectedMessagesText([media], conversation, demo.user)).toContain('(时间未知)\n[图片]');
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
