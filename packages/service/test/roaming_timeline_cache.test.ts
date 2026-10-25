import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteStub, closeAllFixtureDbs } from '@weq/testkit';
import type { Platform } from '@weq/platform';
import type { AccountSession } from '@weq/account';
import { GapHistoryService, type GapFetchedMessage } from '../src/account/gap_history';
import { RoamMsgCacheDb } from '../src/account/roam_msg_cache';
import { DeletedMsgStore } from '../src/account/deleted_msgs';
import { MsgService } from '../src/account/msg';
import { UserConfigService } from '../src/bootstrap/user_config';
import { MessageSendService } from '../src/account/message_send';
import { encode, SEND_MESSAGE_RESPONSE } from '@weq/protocol';

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
      {} as AccountSession,
      () => {
        throw Error('offline');
      },
      path,
    ),
  };
}
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

describe('offline roaming timeline cache pages', () => {
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
      if (kind === 'c2c')
        expect(
          await reopened.resolveReplySeq(conv, before[0]!.clientSeq!, '10001', '1700000000'),
        ).toBe('19749');
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
      expect(after[0]!.decoration?.fontId).toBe(32002);
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
  it('persists the seq display toggle and preserves unrelated settings', () => {
    const { root } = setup();
    const platform = { appDataRoot: () => root } as Platform;
    const config = new UserConfigService(platform);
    expect(config.getSettings().showMessageSeq).toBe(false);
    expect(config.getSettings().showMessageTime).toBe(false);
    config.setSettings({ showMessageSeq: true });
    config.setSettings({ showMessageTime: true });
    config.setSettings({ preferCdn: true });
    const reopened = new UserConfigService(platform);
    expect(reopened.getSettings().showMessageSeq).toBe(true);
    expect(reopened.getSettings().showMessageTime).toBe(true);
    reopened.setSettings({ showMessageSeq: false });
    expect(new UserConfigService(platform).getSettings().showMessageSeq).toBe(false);
    expect(reopened.getSettings().preferCdn).toBe(true);
  });
});
