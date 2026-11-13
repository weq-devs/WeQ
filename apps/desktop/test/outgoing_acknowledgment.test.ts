import { describe, expect, it } from 'vitest';
import {
  expectedOutgoingKeys,
  isSeqRejected,
  outgoingSequenceRejected,
} from '../src/renderer/src/lib/outgoingAcknowledgment';

const deviceIds = [
  'u_Wcc5rknRRqRO8y5gxMD6sA',
  'u_rK7NMsbv2ZjEGPdCuOiCfw',
  'u_l7jpPIZxQo0mzJwoEt-SKw',
];
describe('发送回执的场景差异', () => {
  it.each(deviceIds)('%s 成功的零序号回执保留 random，不伪造 seq 或误标未送达', (targetId) => {
    const receipt = {
      ok: true,
      result: 0,
      peerType: 'c2c' as const,
      targetId,
      groupSequence: 0,
      privateSequence: 0,
      random: 123,
    };
    expect(isSeqRejected(receipt)).toBe(false);
    expect(expectedOutgoingKeys(receipt)).toEqual({ cid: '123', seqRejected: false });
  });
  it('普通私聊和群聊仍保留零序号未确认判断', () => {
    for (const target of [
      { peerType: 'c2c' as const, targetId: 'u_buddy' },
      { peerType: 'group' as const, targetId: '12345' },
      { peerType: 'group' as const, targetId: deviceIds[0] },
    ]) {
      const receipt = { ...target, ok: true, groupSequence: 0, privateSequence: 0, random: 123 };
      expect(isSeqRejected(receipt)).toBe(true);
      expect(expectedOutgoingKeys(receipt).seqRejected).toBe(true);
    }
    expect(
      expectedOutgoingKeys({ ok: true, peerType: 'c2c', privateSequence: 42, random: 123 }),
    ).toEqual({ cid: '123', seq: '42' });
  });
  it('缺少成功证据或明确拒绝时，不因设备目标放宽失败判断', () => {
    for (const partial of [
      { ok: false, result: 79 },
      { ok: true, result: 79 },
      { ok: undefined },
    ]) {
      const receipt = {
        ...partial,
        peerType: 'c2c' as const,
        targetId: deviceIds[0],
        privateSequence: 0,
      };
      expect(isSeqRejected(receipt)).toBe(true);
      expect(expectedOutgoingKeys(receipt).seqRejected).toBe(true);
    }
  });
  it('旧设备成功占位的误标可以直接投影修正，不隐藏真实失败', () => {
    const old = { convId: deviceIds[0]!, state: 'sent' as const, seqRejected: true };
    expect(outgoingSequenceRejected(old)).toBe(false);
    expect(outgoingSequenceRejected({ ...old, convId: 'u_buddy' })).toBe(true);
    expect(outgoingSequenceRejected({ ...old, state: 'failed' })).toBe(true);
    expect(outgoingSequenceRejected({ ...old, state: 'sending' })).toBe(true);
  });
});
