import { describe, expect, it } from 'vitest';
import {
  canDiscardFailedMessage,
  captureOutgoingAfterSeq,
  failedOutgoingRemoval,
  mergeOptimisticInto,
  needsFailedPreparation,
  matchForwardMessages,
  type LocalOutgoingRecord,
} from '../src/renderer/src/lib/localOutgoing';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

const demo = createTemplateDemoData();
const message = {
  ...demo.messages[0]!,
  id: 'optimistic-failure',
  conversationId: '123',
  optimistic: 'failed' as const,
  msgSeq: undefined,
  msgRandom: undefined,
  createdAt: '2026-10-21T01:00:01Z',
};
const record: LocalOutgoingRecord = {
  id: message.id,
  convId: message.conversationId,
  state: 'failed',
};

describe('合并转发占位对账', () => {
  const pending = {
    id: 'optimistic-forward',
    convId: 'target',
    state: 'sent' as const,
    at: 1792544400000,
    resId: 'res-fixture',
    cid: '77',
    seq: '42',
  };
  const wire = {
    msgId: '9007199254740993',
    msgSeq: '42',
    msgRandom: '77',
    sendTime: '1792544400',
    elements: [
      {
        type: 'ark',
        data: {
          arkData: JSON.stringify({
            app: 'com.tencent.multimsg',
            meta: { detail: { resid: pending.resId } },
          }),
        },
      },
    ],
  };
  it('真实 Ark 卡片先到、回执后到时能重新对账，不依赖占位数量变化', () => {
    expect(
      matchForwardMessages(
        [{ ...pending, resId: undefined, cid: undefined, seq: undefined, state: 'sending' }],
        [wire],
        'target',
      ).size,
    ).toBe(0);
    expect([...matchForwardMessages([pending], [wire], 'target').keys()]).toEqual([pending.id]);
    expect(matchForwardMessages([{ ...pending, seqRejected: true }], [wire], 'target').size).toBe(
      1,
    );
    expect(
      matchForwardMessages([{ ...pending, cid: undefined, seqRejected: true }], [wire], 'target')
        .size,
    ).toBe(0);
  });
  it('兼容 XML 和直接 resId，限定当前会话且不使用其他人的卡片', () => {
    const noKeys = { ...pending, cid: undefined, seq: undefined };
    for (const data of [
      { resId: pending.resId },
      { xmlContent: `<msg m_resid="${pending.resId}"/>` },
    ]) {
      expect(
        matchForwardMessages(
          [noKeys],
          [{ ...wire, elements: [{ type: 'multiMsg', data }] }],
          'target',
        ).size,
      ).toBe(1);
    }
    expect(matchForwardMessages([pending], [wire], 'other').size).toBe(0);
    expect(matchForwardMessages([noKeys], [{ ...wire, sendTime: '1' }], 'target').size).toBe(0);
    expect(
      matchForwardMessages([pending], [{ ...wire, msgRandom: 'different', msgSeq: '40' }], 'target')
        .size,
    ).toBe(0);
  });
  it('同张卡连续两发只消耗一条真实回声，下一轮不会再消费同一条', () => {
    const a = { ...pending, cid: undefined, seq: undefined };
    const b = { ...a, id: 'optimistic-second' };
    const first = matchForwardMessages([a, b], [wire], 'target');
    expect([...first.keys()]).toEqual([a.id]);
    const consumed = new Map([...first].map(([id, key]) => [key, id]));
    expect(matchForwardMessages([b], [wire], 'target', consumed).size).toBe(0);
    expect(
      matchForwardMessages([b], [wire, { ...wire, msgId: '9007199254740994' }], 'target', consumed)
        .size,
    ).toBe(1);
  });
});

describe('失败占位清理', () => {
  it('水位只来自同一最新会话，私聊未核对序号和未定位的发送不会冒充水位', () => {
    const selection = { id: '123', kind: 'direct' as const };
    const loaded = [
      { msgSeq: '10' },
      { msgSeq: '999', sourceFormat: 'protocol' as const, ntSeqVerified: false },
    ];
    expect(captureOutgoingAfterSeq('123', selection, true, loaded, [])).toBe('10');
    expect(captureOutgoingAfterSeq('123', selection, true, [], [])).toBe('0');
    expect(captureOutgoingAfterSeq('456', selection, true, loaded, [])).toBeUndefined();
    expect(captureOutgoingAfterSeq('123', selection, false, loaded, [])).toBeUndefined();
    expect(
      captureOutgoingAfterSeq('123', selection, true, loaded, [
        [{ ...record, state: 'sent', seq: '11' }],
      ]),
    ).toBe('11');
    expect(
      captureOutgoingAfterSeq('123', selection, true, loaded, [[{ ...record, state: 'sending' }]]),
    ).toBeUndefined();
    expect(captureOutgoingAfterSeq('123', selection, true, loaded, [[record]])).toBe('10');
  });
  it('只接受明确失败、没有确认信号的本机占位', () => {
    expect(canDiscardFailedMessage(message)).toBe(true);
    for (const patch of [
      { id: '123' },
      { optimistic: 'sending' as const },
      { optimistic: 'sent' as const },
      { msgSeq: '42' },
      { msgRandom: '99' },
      { optimisticRejected: true },
      { localSent: true },
      { source: 'roaming' as const },
    ])
      expect(canDiscardFailedMessage({ ...message, ...patch })).toBe(false);
  });
  it('再次检查实际状态和会话，不删除迟到已确认的记录，也不修改原数组', () => {
    const remove = failedOutgoingRemoval(message, '123')!;
    const protectedRows: LocalOutgoingRecord[] = [
      { ...record, state: 'sent' },
      { ...record, state: 'sending' },
      { ...record, seq: '42' },
      { ...record, cid: '99' },
      { ...record, seqRejected: true },
      { ...record, fileSync: { fileId: 'published' } },
      { ...record, convId: '456' },
    ];
    expect(remove(protectedRows)).toBe(protectedRows);
    const rows = [record, ...protectedRows];
    Object.freeze(rows);
    expect(remove(rows)).toEqual(protectedRows);
    expect(rows).toHaveLength(protectedRows.length + 1);
    expect(failedOutgoingRemoval(message, '456')).toBeNull();
    expect(failedOutgoingRemoval({ ...message, optimistic: 'sent' }, '123')).toBeNull();
  });
  it('已创建过或已受理的提交不能在外层异常里重新插入失败占位', () => {
    const submission = {
      id: message.id,
      draft: { body: '合成原稿' },
      started: false,
      accepted: false,
    };
    expect(needsFailedPreparation(submission)).toBe(true);
    expect(needsFailedPreparation({ ...submission, started: true })).toBe(false);
    expect(needsFailedPreparation({ ...submission, accepted: true })).toBe(false);
  });
});

describe('乐观消息与失败位置', () => {
  const real = [
    {
      ...message,
      id: 'real-a',
      optimistic: undefined,
      msgSeq: '10',
      createdAt: '2026-10-21T01:00:00Z',
    },
    {
      ...message,
      id: 'real-b',
      optimistic: undefined,
      msgSeq: '11',
      createdAt: '2026-10-21T01:00:02Z',
    },
  ];
  it('新消息抵达后，失败占位不再永久挤在最新位置', () => {
    expect(mergeOptimisticInto(real, [message]).map((row) => row.id)).toEqual([
      'real-a',
      message.id,
      'real-b',
    ]);
    expect(real.map((row) => row.msgSeq)).toEqual(['10', '11']);
  });
  it('同一秒内的新消息也在失败占位之后，不受服务端秒级时间截断影响', () => {
    const next = { ...real[1]!, createdAt: '2026-10-21T01:00:01Z' };
    const failed = { ...message, createdAt: '2026-10-21T01:00:01.900Z', optimisticAfterSeq: '10' };
    expect(mergeOptimisticInto([real[0]!, next], [failed]).map((row) => row.id)).toEqual([
      'real-a',
      message.id,
      'real-b',
    ]);
    expect(canDiscardFailedMessage(failed)).toBe(true);
  });
  it('保留已确认序号、发送中占位及历史窗口外的原行为', () => {
    const pending = [
      { ...message, id: 'accepted', optimistic: 'sent' as const, msgSeq: '10' },
      { ...message, id: 'old', optimistic: 'sent' as const, msgSeq: '9' },
      { ...message, id: 'sending', optimistic: 'sending' as const },
    ];
    expect(mergeOptimisticInto(real, pending).map((row) => row.id)).toEqual([
      'real-a',
      'accepted',
      'real-b',
      'old',
      'sending',
    ]);
    expect(mergeOptimisticInto(real, [])).toBe(real);
  });
  it('多种失败按创建时间定位，没有可信时间时保留条目而不伪造位置', () => {
    const later = { ...message, id: 'later', createdAt: '2026-10-21T01:00:01.500Z' };
    const unknown = { ...message, id: 'unknown', createdAt: 'invalid' };
    expect(mergeOptimisticInto(real, [later, unknown, message]).map((row) => row.id)).toEqual([
      'real-a',
      message.id,
      'later',
      'real-b',
      'unknown',
    ]);
  });
});
