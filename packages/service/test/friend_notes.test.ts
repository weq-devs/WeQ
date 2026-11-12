import { describe, expect, it, vi } from 'vitest';
import { decode, encode, message } from '@weq/protocol';
import { legacyOidbEnvelope } from '../../protocol/src/oidb/legacy';
import { parseFriendNoteCard } from '../../protocol/src/oidb/profile/friend-notes';
import {
  cardHex,
  summaryV3Hex,
  emptySummaryHex,
  failedSummaryHex,
} from '../../protocol/test/fixtures/friend-notes';
import { AccountWriteService } from '../src/account/account_write';

const detail = message([
  { name: 'id', tag: 1, type: 'bytes' },
  { name: 'card', tag: 2, type: 'bytes' },
]);
const cardRequest = message([{ name: 'card', tag: 1, type: 'bytes' }]);
const notes = {
  company: '我的公司备注',
  phones: ['10086', '10010'],
  descriptions: ['我写的说明', '第二项'],
};

function fixture() {
  let live = true;
  let summary = summaryV3Hex;
  let card = Buffer.from(cardHex, 'hex');
  let failWrite = false;
  let listedCards: Uint8Array[] = [];
  let afterRead = () => {};
  const writes: Buffer[] = [];
  const sendPacket = vi.fn(async (_pid: number, cmd: string, bytes: Buffer) => {
    if (cmd === 'SummaryCard.ReqSummaryCard') return Buffer.from(summary, 'hex');
    const request = decode(legacyOidbEnvelope, bytes);
    let response: Uint8Array;
    if (cmd === 'OidbSvc.0x43c_4') {
      response = encode(
        message([
          { name: 'seq', tag: 1, type: 'uint32' },
          { name: 'next', tag: 2, type: 'uint32' },
          { name: 'cards', tag: 3, type: 'bytes', repeated: true },
        ]),
        { seq: 96, next: 0xffffffff, cards: listedCards },
      );
      afterRead();
    } else if (cmd === 'OidbSvc.0x43c_5') {
      response = encode(detail, { id: Buffer.from('id'), card });
      afterRead();
    } else {
      writes.push(bytes);
      if (failWrite) throw new Error('timeout');
      card = Buffer.from(decode(cardRequest, request.body as Uint8Array).card as Uint8Array);
      response = cmd.endsWith('_1') ? encode(detail, { id: Buffer.from('id') }) : new Uint8Array();
    }
    return Buffer.from(
      encode(legacyOidbEnvelope, {
        command: 0x43c,
        serviceType: request.serviceType,
        result: 0,
        body: response,
      }),
    );
  });
  const sendOidbPacket = vi.fn(async () => Buffer.alloc(0));
  const service = new AccountWriteService(
    { sendPacket, sendOidbPacket },
    {
      uin: '10001',
      selfUid: 'u_self',
      getBuddy: async (uid) =>
        uid === 'u_peer' ? { uid, uin: 10002n, qid: '', categoryId: 0 } : null,
      listCategories: async () => [],
    },
    () => {
      if (!live) throw new Error('账号已切换');
      return 7;
    },
  );
  return {
    service,
    writes,
    sendPacket,
    sendOidbPacket,
    card: () => card,
    change: () => {
      card = Buffer.concat([card, Buffer.from('a00601', 'hex')]);
    },
    empty: () => {
      summary = emptySummaryHex;
    },
    failRead: () => {
      summary = failedSummaryHex;
    },
    listCard: () => {
      listedCards = [card];
    },
    failWrite: () => {
      failWrite = true;
    },
    switchDuringRead: () => {
      afterRead = () => {
        live = false;
      };
    },
  };
}

describe('我的好友备注资料编排', () => {
  it('SummaryCard 151 时用列表明确命中的 ID 读回详情，已有资料仍可正常保存', async () => {
    const f = fixture();
    f.failRead();
    f.listCard();
    const before = await f.service.getFriendNotes('u_peer');
    expect(before).toMatchObject({
      exists: true,
      company: 'C',
      phones: ['1', '2'],
      descriptions: ['a'],
    });
    expect(f.sendPacket.mock.calls.map((call) => call[1])).toEqual([
      'SummaryCard.ReqSummaryCard',
      'OidbSvc.0x43c_4',
      'OidbSvc.0x43c_5',
    ]);
    expect(await f.service.friendNotes('u_peer', before.revision, notes)).toEqual({
      state: 'accepted',
    });
    expect(decode(legacyOidbEnvelope, f.writes[0]!).serviceType).toBe(3);
  });
  it('151 后列表未命中不当成空备注，列表读取期间切号不再发详情请求', async () => {
    const f = fixture();
    f.failRead();
    await expect(f.service.getFriendNotes('u_peer')).rejects.toThrow('151');
    expect(f.writes).toHaveLength(0);
    const switched = fixture();
    switched.failRead();
    switched.listCard();
    switched.switchDuringRead();
    await expect(switched.service.getFriendNotes('u_peer')).rejects.toThrow('切换');
    expect(switched.sendPacket.mock.calls.map((call) => call[1])).toEqual([
      'SummaryCard.ReqSummaryCard',
      'OidbSvc.0x43c_4',
    ]);
  });
  it('备用路径和主路径生成同一修订；普通网络错误不触发列表请求', async () => {
    const f = fixture();
    const original = await f.service.getFriendNotes('u_peer');
    f.failRead();
    f.listCard();
    expect((await f.service.getFriendNotes('u_peer')).revision).toBe(original.revision);
    const failed = fixture();
    failed.sendPacket.mockRejectedValueOnce(new Error('timeout'));
    await expect(failed.service.getFriendNotes('u_peer')).rejects.toThrow('timeout');
    expect(failed.sendPacket.mock.calls.map((call) => call[1])).toEqual([
      'SummaryCard.ReqSummaryCard',
    ]);
  });
  it('读取关联名片及完整详情，返回私有备注视图、不泄出原始名片', async () => {
    const f = fixture();
    const result = await f.service.getFriendNotes('u_peer');
    expect(result).toMatchObject({
      uid: 'u_peer',
      exists: true,
      company: 'C',
      phones: ['1', '2'],
      descriptions: ['a'],
    });
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(result).not.toHaveProperty('raw');
    expect(result).not.toHaveProperty('id');
    expect(f.sendOidbPacket).not.toHaveBeenCalled();
  });
  it('保存前重读，原字段保留；原值不变不发送写请求', async () => {
    const f = fixture();
    const before = await f.service.getFriendNotes('u_peer');
    expect(await f.service.friendNotes('u_peer', before.revision, before)).toEqual({
      state: 'unchanged',
    });
    expect(f.writes).toHaveLength(0);
    expect(await f.service.friendNotes('u_peer', before.revision, notes)).toEqual({
      state: 'accepted',
    });
    expect(f.writes).toHaveLength(1);
    expect(parseFriendNoteCard(f.card(), '10002')).toMatchObject(notes);
    expect(f.card().includes(Buffer.from('1a046e616d65', 'hex'))).toBe(true);
    expect(f.sendOidbPacket).not.toHaveBeenCalled();
  });
  it('旧快照、非好友、切号和失败基线均不写入，不把错误当空资料', async () => {
    const f = fixture();
    const before = await f.service.getFriendNotes('u_peer');
    f.change();
    await expect(f.service.friendNotes('u_peer', before.revision, notes)).rejects.toThrow('已变化');
    await expect(f.service.getFriendNotes('u_other')).rejects.toThrow('不是');
    f.failRead();
    await expect(f.service.friendNotes('u_peer', before.revision, notes)).rejects.toThrow('151');
    expect(f.writes).toHaveLength(0);
    const switched = fixture();
    const baseline = await switched.service.getFriendNotes('u_peer');
    switched.switchDuringRead();
    await expect(switched.service.friendNotes('u_peer', baseline.revision, notes)).rejects.toThrow(
      '切换',
    );
    expect(switched.writes).toHaveLength(0);
  });
  it('写请求超时只返回待核对，不自动重发', async () => {
    const f = fixture();
    const before = await f.service.getFriendNotes('u_peer');
    f.failWrite();
    expect(await f.service.friendNotes('u_peer', before.revision, notes)).toEqual({
      state: 'unconfirmed',
    });
    expect(f.writes).toHaveLength(1);
  });
  it('仅成功空名片可新增，普通备注需明确读取，使用他人名片分支', async () => {
    const f = fixture();
    f.empty();
    const before = await f.service.getFriendNotes('u_peer');
    expect(before.exists).toBe(false);
    vi.spyOn(f.service, 'getFriendRemark').mockResolvedValue({
      uid: 'u_peer',
      remark: '我的备注名',
    });
    expect(await f.service.friendNotes('u_peer', before.revision, notes)).toEqual({
      state: 'accepted',
    });
    expect(f.writes).toHaveLength(1);
    const outer = decode(legacyOidbEnvelope, f.writes[0]!);
    expect(outer.serviceType).toBe(1);
    expect(
      decode(message([{ name: 'mine', tag: 2, type: 'bool' }]), outer.body as Uint8Array),
    ).toEqual({});
  });
  it('同好友并行保存只放行一个，不在等待读取期间重复写', async () => {
    const f = fixture();
    const before = await f.service.getFriendNotes('u_peer');
    const saving = f.service.friendNotes('u_peer', before.revision, notes);
    await expect(f.service.friendNotes('u_peer', before.revision, notes)).rejects.toThrow(
      '正在保存',
    );
    await saving;
    expect(f.writes).toHaveLength(1);
  });
});
