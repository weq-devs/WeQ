import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProtoMsg } from '@weq/codec';
import { UnreadInfo } from '@weq/codec/proto/msg/48902';
import { UnreadInfoDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('小表直接交付本地水位、减项、标志及最新发送者，不需要消息表', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-unread-small-'));
  roots.push(root);
  const path = join(root, 'msg.db');
  const nt = createSqliteStub();
  const query = vi.spyOn(nt, 'executeSql');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE msg_unread_info_table("48901" TEXT PRIMARY KEY,"48902" BLOB);
    CREATE TABLE recent_contact_v3_table("40021" TEXT,"40003" INTEGER,"40010" INTEGER,"40020" TEXT);
    INSERT INTO recent_contact_v3_table VALUES ('70001',110,2,'u_self')`);
  sql.prepare('INSERT INTO msg_unread_info_table VALUES (?,?)').run(
    '2_70001',
    new ProtoMsg(UnreadInfo).encode({
      info: {
        chatType: 2,
        peerUid: '70001',
        msgSeq: 90,
        localReadSeq: 100,
        decreases: [{ msgSeq: 99 }, { msgSeq: 102 }, { msgSeq: 102 }, { msgSeq: 111 }],
        markUnread: 1,
      },
    }),
  );
  const db = new UnreadInfoDb(nt, { dbPath: path });
  try {
    expect((await db.getUnreadInfos([{ chatType: 2, uid: '70001' }]))[0]).toMatchObject({
      msgSeq: 90,
      localReadSeq: '100',
      decreasedSeqs: ['99', '102', '111'],
      markUnread: true,
      latestSenderUid: 'u_self',
    });
    expect((await db.getAllUnreadInfos())[0]).toMatchObject({
      latestSeq: '110',
      latestSenderUid: 'u_self',
      decreasedSeqs: ['99', '102', '111'],
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(
      query.mock.calls.every(
        ([, text]) => !/group_msg_table|c2c_msg_table|data_version/.test(text),
      ),
    ).toBe(true);
  } finally {
    db.close();
  }
});
