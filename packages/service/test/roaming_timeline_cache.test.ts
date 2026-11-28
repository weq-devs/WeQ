import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSqliteStub, closeAllFixtureDbs, fixtureDb } from '@weq/testkit';
import type { Platform } from '@weq/platform';
import type { AccountSession } from '@weq/account';
import { GapHistoryService, type GapFetchedMessage } from '../src/account/gap_history';
import { RoamMsgCacheDb } from '../src/account/roam_msg_cache';
import { DeletedMsgStore } from '../src/account/deleted_msgs';
import { MsgService } from '../src/account/msg';
import { UserConfigService } from '../src/bootstrap/user_config';
import { MessageSendService } from '../src/account/message_send';
import { encode, MSG_CONTENT, PUSH_MSG_BODY, SEND_MESSAGE_RESPONSE } from '@weqbot/protocol';
import { databasePerformance } from '@weq/db';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'weq-roaming-timeline-'));
  roots.push(root);
  const nt = createSqliteStub();
  const path = join(root, 'synthetic-cache.db');
  return {
    root,
    nt,
    path,
    cache: new RoamMsgCacheDb(nt, path),
    history: new GapHistoryService(
      nt,
      { msgDbPath: path } as AccountSession,
      () => {
        throw Error('offline');
      },
      path,
    ),
  };
}
it('本机漫游时间线读取记录独立阶段，空缓存也计时且不联网', async () => {
  const { history, path } = setup();
  expect(await history.cachedTimeline('group', '777', 1, 100, 25, true)).toEqual([]);
  expect(databasePerformance(path).phases.roamingCache?.count).toBe(1);
});
function message(
  seq: number,
  kind: 'group' | 'c2c' = 'group',
  verified = false,
): GapFetchedMessage {
  return {
    kind,
    conv: 'synthetic-conversation',
    msgId: `random-${seq}`,
    msgSeq: String(seq),
    senderUid: 'synthetic-sender',
    senderUin: '10000',
    sendTime: '1700000000',
    elements: [],
    ntSeqVerified: verified,
  };
}

it('旧发送缓存恢复经典表情 0，保留其他表情及来信原样', async () => {
  const { cache } = setup();
  const oldFace = { type: 'face', data: { subType: 1 } } as GapFetchedMessage['elements'][number];
  const smile = { type: 'face' as const, data: { subType: 1, faceId: 14, faceText: '/微笑' } };
  const sent = { ...message(12, 'c2c', true), msgId: '12', sourceFormat: 'protocol' as const };
  const received = { ...sent, msgId: '13', msgSeq: '13', elements: [oldFace] };
  await cache.store([{ ...sent, localSent: true, elements: [oldFace, smile] }, received]);

  expect((await cache.sentMessages(sent.kind, sent.conv))[0]?.elements).toEqual([
    { type: 'face', data: { subType: 1, faceId: 0 } },
    smile,
  ]);
  expect((await cache.findByMsgId(received.msgId))?.elements).toEqual([oldFace]);
});

it('旧漫游缓存读取时恢复文件接收灰条，普通文件仍可读取', async () => {
  const { cache, history } = setup();
  const file = { fileName: 'notes.txt', fileSize: 1024, fileToken: 'transfer-id' };
  const rows = [1, 2].map(
    (subcmd): GapFetchedMessage => ({
      ...message(subcmd, 'c2c', true),
      msgId: String(subcmd + 10),
      sourceFormat: 'protocol',
      elements: [{ type: 'file', data: { ...file, subType: 1 } }],
      protocolRaw: Buffer.from(
        encode(PUSH_MSG_BODY, {
          contentHead: { msgType: 529, subType: 4, c2cCmd: 4 },
          body: {
            msgContent: encode(MSG_CONTENT, {
              notOnlineFile: {
                fileType: 1,
                subcmd,
                fileName: file.fileName,
                fileSize: BigInt(file.fileSize),
                fileUuid: file.fileToken,
              },
            }),
          },
        }),
      ).toString('base64'),
    }),
  );
  await cache.store(rows);

  const result = await history.cachedTimeline('c2c', rows[0]!.conv, 1, 2, 2, false);
  expect(result).toMatchObject([
    { msgId: '11', msgSeq: '1', elements: [{ type: 'file', data: file }] },
    {
      msgId: '12',
      msgSeq: '2',
      elements: [{ type: 'grayTipFileRecv', data: { ...file, subType: 10 } }],
    },
  ]);
});

it('消息详情仅取撤回缓存，一次索引读取保持协议优先与原生采纳状态', async () => {
  const { cache, path, nt } = setup();
  const recall = { revokeUid: 'u_peer', sameSender: true, recallTs: 1700000010 };
  const protocol = { ...message(1), sourceFormat: 'protocol' as const };
  const native = { ...message(2), sourceFormat: 'native' as const, nativeRaw: { elements: [] } };
  const legacy = message(3);
  await cache.store([legacy, protocol, { ...native, recall }]);
  await cache.storeNative([{ ...native, msgId: protocol.msgId, recall }], true);
  await cache.storeNative([{ ...native, msgId: 'unaccepted', recall }], false);

  const read = vi.spyOn(nt, 'executeSql');
  const options = { recalledOnly: true };
  expect(await cache.findByMsgId(protocol.msgId, options)).toBeNull();
  expect(await cache.findByMsgId('unaccepted', options)).toBeNull();
  expect(await cache.findByMsgId(legacy.msgId, options)).toBeNull();
  expect(await cache.findByMsgId(native.msgId, options)).toMatchObject({ recall });
  expect(read).toHaveBeenCalledTimes(4);

  const [, statement, params] = read.mock.calls[0]!;
  const plan = fixtureDb(path)
    .prepare(`EXPLAIN QUERY PLAN ${statement}`)
    .all(...(params ?? []));
  const details = plan.map((row) => row.detail).join('\n');
  expect(details).toContain('SEARCH protocol_gap_msg USING INDEX protocol_gap_id');
  expect(details).toContain('SEARCH native_gap_msg USING INDEX native_gap_accepted_id');
  expect(await cache.findByMsgId(legacy.msgId)).toMatchObject({ msgId: legacy.msgId });
});

it('日历缓存读取仅投影元数据，保留去重/验证身份且不触发建表写入', async () => {
  const { cache, nt } = setup();
  await cache.store([
    {
      ...message(12, 'c2c', true),
      msgId: '9007199254740993001',
      sourceFormat: 'protocol',
      elements: [{ type: 'text', data: { textContent: '不应复制到计数路径' } }],
    },
    { ...message(13, 'c2c', false), msgId: '9007199254740993002', sourceFormat: 'protocol' },
  ]);
  const write = vi.spyOn(nt, 'executeSqlWrite');
  const rows = await cache.query(
    'c2c',
    'synthetic-conversation',
    1,
    100,
    true,
    256,
    false,
    false,
    undefined,
    true,
  );
  expect(rows.map((row) => row.msgId)).toEqual(['9007199254740993001']);
  expect(rows[0]?.elements).toEqual([]);
  expect(rows[0]?.ntSeqVerified).toBe(true);
  expect(await cache.calendarConversations('c2c', ['synthetic-conversation'])).toEqual([
    'synthetic-conversation',
  ]);
  expect(write).not.toHaveBeenCalled();
});

it('没有漫游缓存时日历不创建替代库或表', async () => {
  const { cache, nt } = setup();
  const write = vi.spyOn(nt, 'executeSqlWrite');
  expect(await cache.calendarConversations('group', ['synthetic-conversation'])).toEqual([]);
  expect(
    await cache.query(
      'group',
      'synthetic-conversation',
      1,
      100,
      false,
      256,
      false,
      false,
      undefined,
      true,
    ),
  ).toEqual([]);
  expect(write).not.toHaveBeenCalled();
});

it('日历只在请求范围内查找三类缓存，跨批保留会话且忽略未采纳的原生缓存', async () => {
  const { cache } = setup();
  const native = {
    ...message(2),
    conv: 'native',
    sourceFormat: 'native' as const,
    nativeRaw: { elements: [] },
  };
  await cache.store([
    { ...message(1), conv: 'legacy' },
    native,
    { ...message(3), conv: 'protocol', sourceFormat: 'protocol' },
    { ...message(4), conv: 'outside-scope' },
    { ...message(5, 'c2c', true), conv: 'other-kind' },
  ]);
  await cache.storeNative([{ ...native, conv: 'unaccepted' }], false);

  expect(
    await cache.calendarConversations('group', [
      'legacy',
      'unaccepted',
      'other-kind',
      ...Array.from({ length: 128 }, (_, index) => `missing-${index}`),
      'native',
      'protocol',
    ]),
  ).toEqual(['legacy', 'native', 'protocol']);
});

it('日历缓存先按半开日期过滤再分页，三种来源、同序号与跨日边界不漏不重', async () => {
  const { cache, history, nt } = setup();
  const start = Date.parse('2026-11-08T00:00:00+08:00') / 1000;
  for (const sourceFormat of [undefined, 'native', 'protocol'] as const) {
    await cache.store(
      [start - 1, start, start + 1, start + 86400].map((sendTime, index) => ({
        ...message(index + 1),
        msgId: String(index + 1),
        msgRandom: String(index + 1),
        sendTime: String(sendTime),
        sourceFormat,
        ...(sourceFormat === 'native' ? { nativeRaw: { elements: [] } } : {}),
      })),
    );
  }
  const write = vi.spyOn(nt, 'executeSqlWrite');
  const first = await history.calendarPage('group', 'synthetic-conversation', 1, undefined, {
    start,
    end: start + 86400,
  });
  expect(first.map((row) => row.msgSeq)).toEqual(['2']);
  const last = first[0]!;
  const next = await history.calendarPage(
    'group',
    'synthetic-conversation',
    1,
    {
      msgSeq: Number(last.msgSeq),
      sendTime: Number(last.sendTime),
      msgId: last.msgId,
    },
    { start, end: start + 86400 },
  );
  expect(next.map((row) => row.msgSeq)).toEqual(['3']);
  expect(
    await history.calendarPage('group', 'synthetic-conversation', 256, undefined, {
      start: start + 2,
      end: start + 86400,
    }),
  ).toEqual([]);
  expect(write).not.toHaveBeenCalled();
});

it('日历日期预筛选不复活已被原生来源覆盖的跨日协议记录', async () => {
  const { cache, history } = setup();
  const start = Date.parse('2026-11-08T00:00:00+08:00') / 1000;
  const protocol = {
    ...message(12),
    msgId: '12',
    sendTime: String(start),
    sourceFormat: 'protocol' as const,
  };
  await cache.store([
    protocol,
    {
      ...protocol,
      sourceFormat: 'native',
      nativeRaw: { elements: [] },
      sendTime: String(start + 86400),
    },
  ]);
  expect(
    await history.calendarPage('group', protocol.conv, 256, undefined, {
      start,
      end: start + 86400,
    }),
  ).toEqual([]);
  expect(
    (
      await history.calendarPage('group', protocol.conv, 256, undefined, {
        start: start + 86400,
        end: start + 172800,
      })
    ).map((row) => row.sourceFormat),
  ).toEqual(['native']);
});

describe('offline roaming timeline cache pages', () => {
  it('原生负数 ID 与正数 ID 的同序号排序和续页一致', async () => {
    const { cache, history } = setup();
    await cache.store(
      ['-2', '-1', '2'].map((msgId) => ({
        ...message(12),
        msgId,
        sourceFormat: 'protocol' as const,
      })),
    );
    expect(
      (await history.cachedTimeline('group', 'synthetic-conversation', 1, 100, 3, true)).map(
        (row) => row.msgId,
      ),
    ).toEqual(['-2', '-1', '2']);
    expect(
      (
        await history.cachedTimeline('group', 'synthetic-conversation', 1, 100, 1, true, {
          msgSeq: 12,
          sendTime: 1700000000,
          msgId: '-1',
        })
      ).map((row) => row.msgId),
    ).toEqual(['-2']);
  });
  it('同序号缓存用时间与完整十进制 ID 续页，不经 JS number 或 int64 截断', async () => {
    const { cache, history } = setup();
    const ids = ['9007199254740993001', '9007199254740993002', '18446744073709551615'];
    await cache.store(
      ids.map((msgId) => ({ ...message(12), msgId, sourceFormat: 'protocol' as const })),
    );
    const first = await history.cachedTimeline('group', 'synthetic-conversation', 1, 100, 1, true);
    expect(first[0]?.msgId).toBe(ids[2]);
    const second = await history.cachedTimeline(
      'group',
      'synthetic-conversation',
      1,
      100,
      1,
      true,
      { msgSeq: 12, sendTime: 1700000000, msgId: first[0]!.msgId },
    );
    expect(second[0]?.msgId).toBe(ids[1]);
    const third = await history.cachedTimeline('group', 'synthetic-conversation', 1, 100, 1, true, {
      msgSeq: 12,
      sendTime: 1700000000,
      msgId: second[0]!.msgId,
    });
    expect(third[0]?.msgId).toBe(ids[0]);
  });
  it('空缓存和三来源混合页均只做一次查询，重复来源不挤掉分页后的独立消息', async () => {
    const { cache, nt } = setup();
    await cache.query('group', 'synthetic-conversation', 1, 10);
    const read = vi.spyOn(nt, 'executeSql');
    expect(await cache.query('group', 'synthetic-conversation', 1, 10)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    await cache.store([
      ...[1, 2, 3].map((seq) => ({ ...message(seq), msgId: String(seq) })),
      ...[2, 3].map((seq) => ({
        ...message(seq),
        msgId: String(seq),
        msgRandom: String(seq),
        sourceFormat: 'native' as const,
        nativeRaw: { elements: [] },
      })),
      ...[2, 3].map((seq) => ({
        ...message(seq),
        msgId: String(seq),
        sourceFormat: 'protocol' as const,
      })),
    ]);
    read.mockClear();
    const rows = await cache.query('group', 'synthetic-conversation', 1, 10, false, 3);
    expect([...new Set(rows.map((row) => row.msgSeq))]).toEqual(['1', '2', '3']);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRestore();
  });
  it('同消息跨缓存格式不绕过隐藏标记，同序号不同消息仍保留', async () => {
    const { root, nt, path, cache } = setup();
    const store = new DeletedMsgStore(join(root, 'deleted.json'));
    const msgs = new MsgService({} as never, store);
    const history = new GapHistoryService(nt, {} as never, () => 42, path, store);
    const protocol = { ...message(2), msgId: '77', sourceFormat: 'protocol' as const };
    await cache.store([
      protocol,
      { ...protocol, sourceFormat: 'native', nativeRaw: { elements: [] } },
      { ...protocol, msgId: '78' },
    ]);
    expect(msgs.deleteCachedSentMessage(protocol, true)).toBe(true);
    expect((await history.cached('group', protocol.conv, 2, 2)).map((row) => row.msgId)).toEqual([
      '78',
    ]);
    expect((await history.cachedForExport('group', protocol.conv)).map((row) => row.msgId)).toEqual(
      ['78'],
    );
    expect(await history.cachedForExport('group', protocol.conv, true)).toHaveLength(2);
    expect(msgs.restoreCachedSentMessage('roaming:native:2:77', 'group', protocol.conv)).toBe(true);
    expect((await history.cached('group', protocol.conv, 2, 2)).map((row) => row.msgId)).toEqual([
      '77',
      '78',
    ]);
  });
  it.each([undefined, 'native', 'protocol'] as const)(
    '隐藏 %s 缓存在分页前排除，仍可从删除列表读取与恢复',
    async (sourceFormat) => {
      const { root, nt, path, cache } = setup();
      const store = new DeletedMsgStore(join(root, 'deleted.json'));
      const msgs = new MsgService({} as never, store);
      const history = new GapHistoryService(
        nt,
        {} as AccountSession,
        () => {
          throw Error('offline');
        },
        path,
        store,
      );
      const rows = [1, 2, 3].map((seq) => ({
        ...message(seq),
        msgId: String(seq),
        sourceFormat,
        ...(sourceFormat === 'native' ? { nativeRaw: { elements: [] } } : {}),
      }));
      await cache.store(rows);
      const id = `roaming:${sourceFormat ? `${sourceFormat}:` : ''}2:2`;
      expect(msgs.deleteCachedSentMessage(rows[1]!, true)).toBe(true);
      expect(
        (await history.cachedTimeline('group', rows[0]!.conv, 1, 3, 2, true)).map(
          (row) => row.msgSeq,
        ),
      ).toEqual(['1', '3']);
      expect((await history.cached('group', rows[0]!.conv, 1, 3)).map((row) => row.msgSeq)).toEqual(
        ['1', '3'],
      );
      expect(await history.cachedForDeletion('group', rows[0]!.conv, 2)).toHaveLength(1);
      expect(await history.cachedForExport('group', rows[0]!.conv)).toHaveLength(2);
      expect(await history.cachedForExport('group', rows[0]!.conv, true)).toHaveLength(3);
      expect(await history.fetch('group', rows[0]!.conv, 2, 2)).toMatchObject({
        ok: false,
        reason: 'offline',
      });
      expect(msgs.restoreCachedSentMessage(id, 'group', rows[0]!.conv)).toBe(true);
      expect(await history.cached('group', rows[0]!.conv, 2, 2)).toHaveLength(1);
    },
  );
  it('64 位相邻序号的缓存正反分页不被消息 ID 字典序颠倒', async () => {
    const { cache } = setup();
    await cache.store([
      { ...message(1), msgSeq: '9007199254740992', msgId: '99' },
      { ...message(2), msgSeq: '9007199254740993', msgId: '10' },
    ]);
    const query = (descending: boolean) =>
      cache.query(
        'group',
        'synthetic-conversation',
        9007199254740992,
        9007199254740994,
        false,
        2,
        descending,
      );
    expect((await query(false)).map((row) => row.msgId)).toEqual(['99', '10']);
    expect((await query(true)).map((row) => row.msgId)).toEqual(['99', '10']);
  });
  it.each(['c2c', 'group'] as const)(
    '保存 %s 已发送消息，重开缓存仍可读，漫游返回真实 ID 后只保留一条',
    async (kind) => {
      const { cache, path, nt } = setup();
      const session = {
        context: { uin: '10001' },
        selfUid: 'u_me',
        uidMap: {
          uidByUin: () => 'u_friend',
          uinByUid: () => 20002n,
          sortNoByUid: () => 1n,
        },
        c2cMsgs: {
          listLatest: async () => [
            { senderUin: 10001n, senderUid: 'u_me', decoration: { fontId2Raw: 72057 } },
          ],
        },
        groupMsgs: {
          listLatest: async () => [
            { senderUin: 10001n, senderUid: 'u_me', decoration: { fontId2Raw: 72057 } },
          ],
        },
      } as unknown as AccountSession;
      const service = new MessageSendService(
        {
          sendPacket: async () =>
            Buffer.from(
              encode(SEND_MESSAGE_RESPONSE, {
                result: 0,
                groupSequence: 19749,
                privateSequence: 19749,
                timestamp1: 1700000000,
              }),
            ),
        } as never,
        session,
        () => 1,
        undefined,
        (row) => cache.store([row]),
        () => 31001,
        () => true,
        () => 2116371,
      );
      const conv = kind === 'c2c' ? 'u_friend' : '12345';
      const outcome = await service.sendText({
        peerType: kind,
        targetId: conv,
        text: '保存后重启',
      });
      const reopened = new RoamMsgCacheDb(nt, path);
      const before = await reopened.query(kind, conv, 1, 20000, kind === 'c2c');
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ localSent: true, msgRandom: String(outcome.random) });
      expect(before[0]!.decoration?.fontId).toBe(31001);
      expect(before[0]!.decoration?.bubbleId).toBe(2116371);
      if (kind === 'c2c') {
        await reopened.store([
          { ...before[0]!, msgId: '90000000002', msgSeq: '19750', ntSeqVerified: false },
        ]);
        expect(
          await reopened.resolveReplySeq(conv, before[0]!.clientSeq!, '10001', '1700000001'),
        ).toBe('19749');
      }
      await reopened.store([
        {
          ...before[0]!,
          localSent: undefined,
          msgId: '90000000001',
          decoration: { bubbleId: 0, widgetId: 0, fontId: 32002 },
        },
      ]);
      const after = await reopened.query(kind, conv, 1, 20000, kind === 'c2c');
      expect(after).toHaveLength(1);
      expect(after[0]!.msgId).toBe('90000000001');
      expect(after[0]!.sentFromWeq).toBe(true);
      expect(after[0]!.decoration?.fontId).toBe(32002);
      expect(after[0]!.decoration?.bubbleId).toBe(0);
    },
  );
  it.each(['protocol', 'native'] as const)(
    '重开后识别 %s 正式记录，即使发送快照在另一页',
    async (sourceFormat) => {
      const { cache, path, nt } = setup();
      const sent: GapFetchedMessage = {
        ...message(42, 'c2c', true),
        msgId: '1234',
        msgRandom: '1234',
        localSent: true,
        sourceFormat: 'protocol',
      };
      const history = {
        ...sent,
        sourceFormat,
        ...(sourceFormat === 'native' ? { nativeRaw: { elements: [] } } : {}),
        msgId: '90001',
        sendTime: '1700000001',
        localSent: undefined,
      };
      const otherSender = { ...history, msgId: '90002', senderUid: 'u_other' };
      const otherRandom = { ...history, msgId: '90003', msgRandom: '5678' };
      const otherConv = { ...history, conv: 'u_other_peer' };
      await cache.store([sent, history, otherSender, otherRandom, otherConv]);
      const reopened = new RoamMsgCacheDb(nt, path);
      const read = (conv: string, limit: number) =>
        reopened.query('c2c', conv, 42, 42, true, limit);

      const shown = await read(sent.conv, 3);
      expect(shown.map((row) => [row.msgId, row.sentFromWeq])).toEqual([
        ['90001', true],
        ['90002', undefined],
        ['90003', undefined],
      ]);
      expect(await read(sent.conv, 10)).toEqual(shown);
      expect((await read(otherConv.conv, 1))[0]?.sentFromWeq).toBeUndefined();
    },
  );
  it.each([false, true])(
    '同 ID 云端回填和发送快照任一先到都保留正式正文（先回填=%s）',
    async (first) => {
      const { cache, path, nt } = setup();
      const sent: GapFetchedMessage = {
        ...message(42, 'c2c', true),
        msgId: '1234',
        msgRandom: '1234',
        localSent: true,
        sourceFormat: 'protocol',
        elements: [{ type: 'text', data: { textContent: '发送回显' } }],
      };
      const history: GapFetchedMessage = {
        ...sent,
        localSent: undefined,
        elements: [{ type: 'text', data: { textContent: '来自 QQ 的完整正文' } }],
      };
      for (const row of first ? [history, sent] : [sent, history]) await cache.store([row]);
      await cache.store([sent, { ...history, elements: [] }, { ...history, ntSeqVerified: false }]);
      const reopened = new RoamMsgCacheDb(nt, path);
      const rows = await reopened.query('c2c', sent.conv, 42, 42, true);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        localSent: true,
        sentFromWeq: true,
        elements: history.elements,
      });
    },
  );
  it('reads group cache pages in either direction, including cache-only history', async () => {
    const { cache, history } = setup();
    await cache.store(Array.from({ length: 120 }, (_, i) => message(i + 1)));
    const latest = await history.cachedTimeline(
      'group',
      'synthetic-conversation',
      1,
      120,
      20,
      true,
    );
    expect(latest.map((r) => Number(r.msgSeq))).toEqual(
      Array.from({ length: 20 }, (_, i) => 101 + i),
    );
    const after = await history.cachedTimeline(
      'group',
      'synthetic-conversation',
      21,
      120,
      20,
      false,
    );
    expect(after.map((r) => Number(r.msgSeq))).toEqual(
      Array.from({ length: 20 }, (_, i) => 21 + i),
    );
    const before = await history.cachedTimeline(
      'group',
      'synthetic-conversation',
      1,
      100,
      20,
      true,
    );
    expect(before[0]?.msgSeq).toBe('81');
    expect(before.at(-1)?.msgSeq).toBe('100');
  });
  it('isolates conversation/type and excludes legacy private-chat cache rows', async () => {
    const { cache, history } = setup();
    await cache.store([message(1, 'c2c'), message(2, 'c2c', true), message(3)]);
    expect(
      (await history.cachedTimeline('c2c', 'synthetic-conversation', 1, 10, 10, true)).map((r) => [
        r.msgSeq,
        r.ntSeqVerified,
      ]),
    ).toEqual([['2', true]]);
    expect(await history.cachedTimeline('group', 'another-conversation', 1, 10, 10, true)).toEqual(
      [],
    );
  });
  it('独立保存序号、日期和时间开关，保留其他设置', () => {
    const { root } = setup();
    const platform = { appDataRoot: () => root } as Platform;
    const config = new UserConfigService(platform);
    expect(config.getSettings().showMessageSeq).toBe(false);
    expect(config.getSettings().showMessageDate).toBe(false);
    expect(config.getSettings().showMessageTime).toBe(false);
    config.setSettings({ showMessageSeq: true });
    config.setSettings({ showMessageDate: true });
    config.setSettings({ showMessageTime: true });
    config.setSettings({ preferCdn: true });
    const reopened = new UserConfigService(platform);
    expect(reopened.getSettings().showMessageSeq).toBe(true);
    expect(reopened.getSettings().showMessageDate).toBe(true);
    expect(reopened.getSettings().showMessageTime).toBe(true);
    reopened.setSettings({ showMessageSeq: false });
    expect(new UserConfigService(platform).getSettings().showMessageSeq).toBe(false);
    reopened.setSettings({ showMessageDate: false });
    const reloaded = new UserConfigService(platform).getSettings();
    expect(reloaded.showMessageDate).toBe(false);
    expect(reloaded.showMessageTime).toBe(true);
    expect(reopened.getSettings().preferCdn).toBe(true);
  });
});
