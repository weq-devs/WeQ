import { describe, expect, it } from 'vitest';
import type { MsgService, RenderC2cMsg } from '@weq/service';
import {
  iterateOfficialMessages,
  iterateServiceMessages,
} from '../src/account/export/message_source';

function message(msgId: number, msgSeq: number, elements: RenderC2cMsg['elements']): RenderC2cMsg {
  return {
    msgId: BigInt(msgId),
    msgSeq: BigInt(msgSeq),
    sendTime: BigInt(msgId),
    senderUid: 'u_sender',
    senderUin: 10001n,
    elements,
  } as unknown as RenderC2cMsg;
}

function messageSource(rows: RenderC2cMsg[]): MsgService {
  const sequenced = rows.filter((row) => row.msgSeq > 0n);
  const seqless = rows
    .filter((row) => row.msgSeq === 0n)
    .map((row) => ({ ...row, rowId: row.msgId }));
  return {
    getC2cAfter: async (_uid: string, afterSeq: bigint) =>
      sequenced.filter((row) => row.msgSeq > afterSeq),
    getC2cSeqlessAfterRowId: async (_uid: string, afterRowId: bigint) =>
      seqless.filter((row) => row.rowId > afterRowId),
    getServiceAfter: async (_appId: string, afterSeq: bigint) =>
      sequenced.filter((row) => row.msgSeq > afterSeq),
    getServiceSeqlessAfterRowId: async (_appId: string, afterRowId: bigint) =>
      seqless.filter((row) => row.rowId > afterRowId),
  } as unknown as MsgService;
}

describe('official and service account exports', () => {
  it.each([
    ['official', iterateOfficialMessages],
    ['service', iterateServiceMessages],
  ] as const)('preserves Ark messages in %s conversations', async (_kind, iterate) => {
    const rows = [
      message(1, 1, [{ type: 'text', data: { textContent: 'ordinary text' } }]),
      message(2, 2, [{ type: 'ark', data: { arkData: '{}' } }]),
      message(3, 3, [
        { type: 'text', data: { textContent: 'card:' } },
        { type: 'ark', data: { arkData: '{}' } },
      ]),
      message(4, 0, [{ type: 'ark', data: { arkData: '{}' } }]),
    ];
    const exported: bigint[] = [];
    for await (const item of iterate(messageSource(rows), 'u_peer')) exported.push(item.msgId);

    expect(exported).toEqual([2n, 3n, 4n]);
  });
});
