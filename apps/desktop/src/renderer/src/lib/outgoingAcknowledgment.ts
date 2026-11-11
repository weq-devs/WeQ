import { isDatalineUid } from '@weq/codec';

interface SendReceiptPosition {
  ok?: boolean;
  result?: number;
  peerType?: 'c2c' | 'group';
  targetId?: string;
  groupSequence?: number;
  privateSequence?: number;
  random?: number;
}

function acceptedDevice(receipt: SendReceiptPosition): boolean {
  return (
    receipt.ok === true &&
    (receipt.result === undefined || receipt.result === 0) &&
    receipt.peerType === 'c2c' &&
    Boolean(receipt.targetId && isDatalineUid(receipt.targetId))
  );
}

/** 设备回执没有普通会话序号；其余发送仍保留零序号的未确认判断。 */
export function isSeqRejected(receipt: SendReceiptPosition): boolean {
  return (
    !acceptedDevice(receipt) &&
    (receipt.groupSequence ?? 0) <= 0 &&
    (receipt.privateSequence ?? 0) <= 0
  );
}

export function expectedOutgoingKeys(
  receipt: SendReceiptPosition & { peerType: 'c2c' | 'group' },
): {
  cid?: string;
  seq?: string;
  seqRejected?: boolean;
} {
  const seq = receipt.peerType === 'group' ? receipt.groupSequence : receipt.privateSequence;
  return {
    ...(receipt.random && receipt.random > 0 ? { cid: String(receipt.random) } : {}),
    ...(seq && seq > 0 ? { seq: String(seq) } : {}),
    ...(acceptedDevice(receipt) ? { seqRejected: false } : seq === 0 ? { seqRejected: true } : {}),
  };
}

/** 兼容当前窗口里已按旧规则误标的成功设备占位，不改写失败状态或原始消息。 */
export function outgoingSequenceRejected(record: {
  convId: string;
  state: 'queued' | 'sending' | 'sent' | 'failed';
  seqRejected?: boolean;
}): boolean {
  return Boolean(record.seqRejected) && !(record.state === 'sent' && isDatalineUid(record.convId));
}
