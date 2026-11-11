import { describe, expect, it, vi } from 'vitest';
import { decode, encode, message } from '../src/protobuf';
import { encodeFriendSummaryCard, decodeFriendSummaryCard } from '../src/oidb/profile/summary-card';
import {
  parseFriendNoteCard,
  replaceFriendNotes,
  readFriendNoteDetail,
  writeFriendNoteCard,
  newFriendNoteCard,
} from '../src/oidb/profile/friend-notes';
import { legacyOidbEnvelope } from '../src/oidb/legacy';
import {
  cardHex,
  summaryRequestHex,
  summaryV2Hex,
  summaryV3Hex,
  emptySummaryHex,
  failedSummaryHex,
} from './fixtures/friend-notes';

const card = Buffer.from(cardHex, 'hex');
const notes = {
  company: '新公司',
  phones: ['电话1', '电话2'],
  descriptions: ['描述1', '描述2\n换行'],
};

describe('我为好友添加的备注资料协议', () => {
  it('官方场景请求与独立 JCE 编码器黄金字节一致', () => {
    expect(Buffer.from(encodeFriendSummaryCard('10002')).toString('hex')).toBe(summaryRequestHex);
  });
  it.each([summaryV2Hex, summaryV3Hex])('兼容 UniPacket v2/v3 并提取 tag62', (hex) => {
    expect(Buffer.from(decodeFriendSummaryCard(Buffer.from(hex, 'hex'), '10002')!)).toEqual(card);
  });
  it('读取失败不混成没有备注；错目标、截断和错类型不接收', () => {
    const missingCard =
      '10032c3c4001560066007d000031080002060852657370486561641d0000050a00021c0b060f5265737053756d6d617279436172641d0000060af11727120b8c980ca80c';
    expect(() => decodeFriendSummaryCard(Buffer.from(missingCard, 'hex'), '10002')).toThrow('缺失');
    expect(decodeFriendSummaryCard(Buffer.from(emptySummaryHex, 'hex'), '10002')).toBeNull();
    expect(() => decodeFriendSummaryCard(Buffer.from(failedSummaryHex, 'hex'), '10002')).toThrow(
      '151',
    );
    expect(() => decodeFriendSummaryCard(Buffer.from(summaryV3Hex, 'hex'), '10003')).toThrow(
      '目标',
    );
    expect(() =>
      decodeFriendSummaryCard(Buffer.from(summaryV3Hex.slice(0, -20), 'hex'), '10002'),
    ).toThrow();
    expect(() => decodeFriendSummaryCard(Buffer.from([0x1d, 0x01]), '10002')).toThrow();
  });
  it('公司单值，电话与描述按列表解码，拒绝错误关联及重复身份', () => {
    expect(parseFriendNoteCard(card, '10002')).toMatchObject({
      company: 'C',
      phones: ['1', '2'],
      descriptions: ['a'],
    });
    expect(() => parseFriendNoteCard(card, '10003')).toThrow('目标');
    expect(() =>
      parseFriendNoteCard(Buffer.concat([card, Buffer.from('0a0178', 'hex')]), '10002'),
    ).toThrow('重复');
    expect(() => parseFriendNoteCard(card.subarray(0, -1), '10002')).toThrow();
  });
  it('改三项仍逐字保留图片、OCR、未知字段和默认值，不能借 notes 改 ID', () => {
    const untouched = Buffer.from('12037069635a030a0178fa7f030001027000', 'hex');
    const original = Buffer.concat([card, untouched]);
    const injected = { ...notes, id: Buffer.from('other') };
    const changed = replaceFriendNotes(original, '10002', injected);
    expect(changed.includes(untouched)).toBe(true);
    expect(parseFriendNoteCard(changed, '10002')).toMatchObject({
      id: Buffer.from('id'),
      ...notes,
    });
    expect(changed.includes(Buffer.from('1a046e616d65', 'hex'))).toBe(true);
    const cleared = replaceFriendNotes(original, '10002', {
      company: '',
      phones: [],
      descriptions: [],
    });
    expect(parseFriendNoteCard(cleared, '10002')).toMatchObject({
      company: '',
      phones: [],
      descriptions: [],
    });
    expect(cleared.includes(untouched)).toBe(true);
  });
  it('详情校验两层 ID 与关联目标，写入使用旧 OIDB 命令而非 TrpcTcp', async () => {
    const response = message([
      { name: 'id', tag: 1, type: 'bytes' },
      { name: 'card', tag: 2, type: 'bytes' },
    ]);
    const sendPacket = vi.fn(async (_pid: number, cmd: string, _body: Buffer) =>
      Buffer.from(
        encode(legacyOidbEnvelope, {
          command: 0x43c,
          serviceType: cmd.endsWith('_5') ? 5 : 3,
          result: 0,
          body: cmd.endsWith('_5')
            ? encode(response, { id: Buffer.from('id'), card })
            : new Uint8Array(),
        }),
      ),
    );
    expect(
      Buffer.from(await readFriendNoteDetail({ sendPacket }, 7, Buffer.from('id'), '10002')),
    ).toEqual(card);
    await expect(
      readFriendNoteDetail({ sendPacket }, 7, Buffer.from('wrong'), '10002'),
    ).rejects.toThrow('ID');
    await writeFriendNoteCard({ sendPacket }, 7, replaceFriendNotes(card, '10002', notes));
    expect(sendPacket.mock.calls.map((call) => call[1])).toEqual([
      'OidbSvc.0x43c_5',
      'OidbSvc.0x43c_5',
      'OidbSvc.0x43c_3',
    ]);
    const outer = decode(legacyOidbEnvelope, sendPacket.mock.calls[2]![2]);
    expect(outer.command).toBe(0x43c);
    expect(outer.serviceType).toBe(3);
  });
  it('新增绑定实际 QQ，不设置本人名片分支；异常输入在发送前拒绝', () => {
    const added = newFriendNoteCard('10002', '备注', notes);
    const decoded = decode(
      message([
        { name: 'target', tag: 8, type: 'uint64' },
        { name: 'source', tag: 9, type: 'uint32' },
      ]),
      added,
    );
    expect(decoded).toEqual({ target: 10002n, source: 1 });
    expect(() => replaceFriendNotes(card, '10002', { ...notes, phones: [''] })).toThrow();
    expect(() => newFriendNoteCard('u_peer', '', notes)).toThrow();
  });
});
