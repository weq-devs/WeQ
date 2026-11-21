import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import { ElementType, GrayTipSubType, ProtoMsg } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { UnreadInfo } from '@weq/codec/proto/msg/48902';
import { RecentContactDb, type UnreadInfoTarget, UnreadInfoDb } from '@weq/db';
import { emitSettingsChanged } from '@weq/service/settings-changes';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '../../../packages/testkit/src';
import { expect, it, vi } from 'vitest';
import { ConversationInteractionBadges } from '../src/main/context/conversation_interactions';
import { conversationInteractionId } from '../src/shared/conversation_interaction';

it('按真实水位和消息身份确认互动，后续有序号的消息释放已读的无序号记录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-interaction-badge-'));
  const dbPath = join(dir, 'msg.db');
  const statePath = join(dir, 'badges.json');
  const sql = fixtureDb(dbPath);
  sql.exec(`CREATE TABLE recent_contact_v3_table("40021" TEXT,"40010" INTEGER,"40027" INTEGER,"40003" INTEGER,"40050" INTEGER);
    CREATE TABLE msg_unread_info_table("48901" TEXT PRIMARY KEY,"48902" BLOB);
    CREATE TABLE c2c_msg_table("40001" INTEGER PRIMARY KEY,"40027" INTEGER,"40003" INTEGER,"40050" INTEGER,"40011" INTEGER,"40012" INTEGER,"40800" BLOB,"40020" TEXT);
    CREATE INDEX c2c_seq ON c2c_msg_table("40027","40003");
    CREATE TABLE group_msg_table AS SELECT * FROM c2c_msg_table WHERE 0;
    CREATE INDEX group_seq ON group_msg_table("40027","40003");`);
  const now = Math.floor(Date.now() / 1000);
  sql.prepare(`INSERT INTO recent_contact_v3_table VALUES ('u_peer',1,21,102,?)`).run(now);
  const insert = sql.prepare('INSERT INTO c2c_msg_table VALUES (?,?,?,?,?,?,?,?)');
  const codec = new ProtoMsg(MsgBody);
  const poke = (actor: string, target: string) =>
    codec.encode({
      elements: [
        {
          elementType: ElementType.GRAY_TIP,
          subType: GrayTipSubType.JSON,
          detailedId: 1061,
          actionInitiator: { uid: target },
          grayTipXmlContent: `<gtip><qq uin="${actor}"/><nor txt="拍了拍"/><qq uin="${target}"/></gtip>`,
        },
      ],
    });
  const recallBody = codec.encode({
    elements: [
      {
        elementType: ElementType.GRAY_TIP,
        subType: GrayTipSubType.REVOKE,
        recallRevokeUid: 'u_peer',
      },
    ],
  });
  const old = now - 10;
  const plain = new Uint8Array();
  insert.run(10, 21, 100, old, 2, 1, plain, 'u_peer');
  insert.run(20, 21, 101, old + 1, 2, 1, plain, 'u_peer');
  insert.run(30, 21, 102, old + 2, 2, 1, plain, 'u_peer');
  const recentContacts = new RecentContactDb(createSqliteStub(), { dbPath });
  const unread = new UnreadInfoDb(createSqliteStub(), { dbPath });
  const session = {
    context: { uin: '10001' },
    selfUid: 'u_self',
    recentContacts,
  } as AccountSession;
  const readWindow = vi.spyOn(recentContacts, 'recentInteractionWindow');
  const listeners = new Set<(targets: UnreadInfoTarget[]) => void>();
  const target = { chatType: 1, uid: 'u_peer' };
  const unreadCodec = new ProtoMsg(UnreadInfo);
  function readThrough(seq: number) {
    sql
      .prepare(`REPLACE INTO msg_unread_info_table VALUES ('1_u_peer', ?)`)
      .run(unreadCodec.encode({ info: { msgSeq: seq } }));
    for (const listener of listeners) listener([target]);
  }
  const watermarks = () => ({
    async getUnreadInfos(targets: UnreadInfoTarget[]) {
      return Promise.all(
        targets.map(async ({ chatType, uid }) => {
          const row = (await unread.getUnreadInfo(chatType, uid))!;
          return { ...row, latestSeq: null, readSeq: row.msgSeq?.toString() };
        }),
      );
    },
    onCountsChanged(listener: (targets: UnreadInfoTarget[]) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  readThrough(101);
  let enabled = false;
  const badges = new ConversationInteractionBadges(session, statePath, () => enabled, watermarks);
  const changed = vi.fn();
  badges.subscribe(changed);
  try {
    expect(readWindow).not.toHaveBeenCalled();
    const notified = { kind: 'c2c', conv: 'u_peer', msgId: '9', action: 'recall' } as const;
    const notice = { ...notified, revokeUid: 'u_peer', senderUid: 'u_peer', origSeq: '99' };
    badges.observeRecall(notice);
    expect(changed).toHaveBeenCalledTimes(1);
    badges.observeRecall(notice, true);
    expect(changed).toHaveBeenLastCalledWith([{ ...notified, bannerPending: true }]);
    expect(badges.badgeEvents).toEqual([]);
    const notifiedId = conversationInteractionId(notified);
    badges.acknowledge([notifiedId]);
    expect(changed).toHaveBeenLastCalledWith([]);
    expect(badges.seenIds).toEqual([notifiedId]);
    changed.mockClear();
    enabled = true;
    emitSettingsChanged();
    await vi.waitFor(() => expect(readWindow).toHaveBeenCalledTimes(2));
    expect(changed).not.toHaveBeenCalled();

    insert.run(18, 21, 100, now, 5, 12, poke('u_peer', 'u_self'), 'u_peer');
    insert.run(19, 21, 101, old + 1, 5, 12, poke('u_peer', 'u_self'), 'u_peer');
    insert.run(21, 21, 101, old + 1, 5, 12, poke('u_peer', 'u_self'), 'u_peer');
    insert.run(28, 21, 101, now, 5, 12, poke('u_self', 'u_peer'), 'u_self');
    insert.run(29, 21, 101, now, 5, 12, poke('u_peer', 'u_third'), 'u_peer');
    insert.run(31, 21, 0, now, 2, 1, plain, 'u_peer');
    insert.run(32, 21, null, now, 2, 1, plain, 'u_peer');
    insert.run(33, 21, 0, now, 2, 1, plain, 'u_self');
    sql.prepare('UPDATE c2c_msg_table SET "40800"=? WHERE "40001" IN (10,30)').run(recallBody);
    const readRecall = { kind: 'c2c', conv: 'u_peer', msgId: '10', action: 'recall' } as const;
    badges.observeRecall({ ...notice, msgId: '10', origSeq: '100' }, true);
    badges.requestScan();
    const newPoke = { kind: 'c2c', conv: 'u_peer', msgId: '21', action: 'poke' } as const;
    const recall = { ...newPoke, msgId: '30', action: 'recall' } as const;
    await vi.waitFor(() => {
      expect(badges.badgeEvents.map((event) => event.msgId).sort()).toEqual([
        '21',
        '30',
        '31',
        '32',
      ]);
      expect(changed.mock.calls.at(-1)?.[0]).toContainEqual({ ...readRecall, bannerPending: true });
    });
    expect(badges.unsequencedIds('c2c', 'u_peer')).toEqual([31n, 32n]);
    badges.observeRecall({ ...notice, msgId: '30', origSeq: '102' }, true);
    badges.acknowledge([conversationInteractionId(recall)], true);
    expect(badges.badgeEvents).toContainEqual(recall);
    expect(changed.mock.calls.at(-1)?.[0]).not.toContainEqual({ ...recall, bannerPending: true });

    badges.acknowledge([conversationInteractionId(newPoke), conversationInteractionId(recall)]);
    expect(badges.badgeEvents.map((event) => event.msgId).sort()).toEqual(['31', '32']);
    expect(badges.seenIds).toContain(conversationInteractionId(recall));
    expect(readFileSync(statePath, 'utf8')).toContain('"msgId":"21"');
    // 再读到 102 前，最近已到达的 102 已经接替 21，无需保存它的逐条已读。
    await vi.waitFor(() => expect(readFileSync(statePath, 'utf8')).not.toContain('"msgId":"21"'));
    badges.dispose();
    const reopened = new ConversationInteractionBadges(
      session,
      statePath,
      () => enabled,
      watermarks,
    );
    try {
      const restored = vi.fn();
      reopened.subscribe(restored);
      await vi.waitFor(() =>
        expect(reopened.badgeEvents.map((event) => event.msgId).sort()).toEqual(['31', '32']),
      );
      reopened.observeRecall({ ...notice, msgId: '30', origSeq: '102' });
      insert.run(40, 21, 103, now, 2, 1, plain, 'u_peer');
      sql.prepare('UPDATE recent_contact_v3_table SET "40003"=103').run();
      readThrough(103);
      await vi.waitFor(() => expect(reopened.badgeEvents).toEqual([]));
      expect(restored).toHaveBeenLastCalledWith([{ ...readRecall, bannerPending: true }]);
      reopened.acknowledge([conversationInteractionId(readRecall)]);
      expect(restored).toHaveBeenLastCalledWith([]);
    } finally {
      reopened.dispose();
    }
  } finally {
    badges.dispose();
    closeAllFixtureDbs();
    rmSync(dir, { recursive: true, force: true });
  }
});
