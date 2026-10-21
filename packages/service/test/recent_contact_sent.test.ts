import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import { ChatType } from '@weq/codec';
import type { RecentContact } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub } from '@weq/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import type { GapFetchedMessage } from '../src/account/gap_history';
import { RecentContactService } from '../src/account/recent_contact';
import { RoamMsgCacheDb } from '../src/account/roam_msg_cache';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function contact(id: string, time = 100, seq = 10): RecentContact {
  return {
    chatType: 'KCHATTYPEC2C',
    targetUid: id,
    targetUin: 20000n,
    msgSeq: BigInt(seq),
    sendTime: BigInt(time),
    senderUid: id,
    preview: { kind: 'text', textContent: '旧摘要' },
    senderDisplayName: '好友',
    senderNick: '好友',
    senderRemark: '备注',
    targetDisplayName: '好友',
    targetRemark: '',
    targetAvatar: '',
    targetGroupNick: '',
    topTime: 1n,
    pinned: true,
    notifyLevel: 4,
    tempSourceGroupCode: 0n,
  };
}

function sent(conv = 'u_friend', time = 200, seq = 11): GapFetchedMessage {
  return {
    kind: 'c2c',
    conv,
    msgId: String(seq),
    msgSeq: String(seq),
    sendTime: String(time),
    senderUid: 'u_self',
    senderUin: '10000',
    sourceFormat: 'protocol',
    localSent: true,
    ntSeqVerified: true,
    elements: [{ type: 'text', data: { textContent: '新消息' } }],
  };
}

function setup(rows: RecentContact[], messages: GapFetchedMessage[]) {
  const list = vi.fn(async (limit = 200, offset = 0) =>
    limit < 0 ? rows.slice(offset) : rows.slice(offset, offset + limit),
  );
  const session = {
    recentContacts: {
      getRecentContact: list,
      getByTargetUids: async (ids: string[]) => rows.filter((row) => ids.includes(row.targetUid)),
    },
  } as unknown as AccountSession;
  return { service: new RecentContactService(session, async () => messages), list };
}

it('已发送消息更新预览和排序，但不改 QQ 未读水位、置顶和备注', async () => {
  const old = contact('u_friend');
  const { service } = setup([contact('u_other', 150), old], [sent()]);
  const rows = await service.getRecentContact(1);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    targetUid: 'u_friend',
    sendTime: 200n,
    senderUid: 'u_self',
    msgSeq: old.msgSeq,
    pinned: true,
    topTime: old.topTime,
    notifyLevel: old.notifyLevel,
    senderRemark: '备注',
    preview: { kind: 'text', textContent: '新消息' },
  });
  expect(old.sendTime).toBe(100n);
});

it('在合并后分页，旧会话的新发送消息不会被原始分页截掉', async () => {
  const { service } = setup([contact('u_other', 150), contact('u_friend')], [sent()]);
  expect((await service.getRecentContact(1, 1)).map((row) => row.targetUid)).toEqual(['u_other']);
  expect(await service.getRecentContact(-1)).toHaveLength(2);
});

it.each([
  [210, 12],
  [200, 11],
  [200, 12],
])('QQ 摘要已追上或更新时优先采用 QQ：%i/%i', async (time, seq) => {
  const current = contact('u_friend', time, seq);
  const { service } = setup([current], [sent()]);
  expect((await service.getRecentContact())[0]).toEqual(current);
});

it('同秒发送的新序号仍更新预览，未确认、外部历史和其他会话不混入', async () => {
  const { service } = setup(
    [contact('u_friend', 200)],
    [
      sent('u_friend', 200),
      { ...sent('u_friend', 300, 12), ntSeqVerified: false },
      { ...sent('u_friend', 400, 13), localSent: false },
      sent('u_absent', 500),
    ],
  );
  expect((await service.getRecentContact())[0]?.preview).toMatchObject({ textContent: '新消息' });
  expect((await service.getRecentContact())[0]?.sendTime).toBe(200n);
});

it('只更新相同类型的会话，不让群与私聊同名键串线', async () => {
  const { service } = setup([contact('12345')], [{ ...sent('12345'), kind: 'group' }]);
  expect((await service.getRecentContact())[0]?.sendTime).toBe(100n);
});

it('表情与文本保留多元素预览，群聊也可使用已确认发送缓存', async () => {
  const group = { ...contact('12345'), chatType: 'KCHATTYPEGROUP' };
  const message = { ...sent('12345'), kind: 'group' as const, ntSeqVerified: false };
  message.elements.push({ type: 'face', data: { faceId: 1, faceText: '微笑' } });
  const { service } = setup([group], [message]);
  expect((await service.getRecentContact())[0]?.preview).toMatchObject({
    previewElements: [
      { kind: 'text', textContent: '新消息' },
      { kind: 'face', faceId: 1 },
    ],
  });
});

it('没有发送缓存时维持原有分页查询，不额外加载所有会话', async () => {
  const { service, list } = setup([contact('u_friend')], []);
  await service.getRecentContact(20, 40, { excludeChatTypes: [103, 118] });
  expect(list).toHaveBeenCalledTimes(1);
  expect(list).toHaveBeenCalledWith(20, 40, { excludeChatTypes: [103, 118] });
});

it('首屏只读前缀并补入发送目标，不把已排除的会话补回来', async () => {
  const { service, list } = setup(
    [contact('u_other', 150), { ...contact('12345'), chatType: 'KCHATTYPEGROUP' }],
    [{ ...sent('12345'), kind: 'group' }],
  );
  expect(
    (await service.getRecentContact(1, 0, { excludeChatTypes: [ChatType.KCHATTYPEGROUP] }))[0]
      ?.targetUid,
  ).toBe('u_other');
  expect(list).toHaveBeenCalledWith(1, 0, { excludeChatTypes: [ChatType.KCHATTYPEGROUP] });
});

it('缓存读取失败不阻断原始会话列表', async () => {
  const current = contact('u_friend');
  const { list } = setup([current], []);
  const session = { recentContacts: { getRecentContact: list } } as unknown as AccountSession;
  const service = new RecentContactService(session, async () => {
    throw Error('fixture');
  });
  expect(await service.getRecentContact()).toEqual([current]);
});

it('从持久化缓存读取每个会话最后一条已确认发送消息，重开仍可用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-sent-preview-'));
  roots.push(root);
  const nt = createSqliteStub();
  const path = join(root, 'cache.db');
  const cache = new RoamMsgCacheDb(nt, path);
  await cache.store([
    sent('u_friend', 100, 10),
    sent(),
    { ...sent('u_friend', 300, 12), ntSeqVerified: false },
    { ...sent('u_friend', 400, 13), localSent: false },
    { ...sent('12345'), kind: 'group', ntSeqVerified: false },
  ]);
  const rows = await new RoamMsgCacheDb(nt, path).latestSent();
  expect(rows.map((row) => [row.kind, row.conv, row.msgSeq]).sort()).toEqual([
    ['c2c', 'u_friend', '11'],
    ['group', '12345', '11'],
  ]);
});
