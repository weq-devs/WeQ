import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import { ElementType, GrayTipSubType, ProtoMsg } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { RecentContactDb } from '@weq/db';
import { emitSettingsChanged } from '@weq/service/settings-changes';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '../../../packages/testkit/src';
import { expect, it, vi } from 'vitest';
import { ConversationInteractionBadges } from '../src/main/context/conversation_interactions';
import { conversationInteractionId } from '../src/shared/conversation_interaction';

it('以真实消息身份保存新互动，原位撤回和同序号戳一戳分别确认', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-interaction-badge-'));
  const dbPath = join(dir, 'msg.db');
  const statePath = join(dir, 'badges.json');
  const sql = fixtureDb(dbPath);
  sql.exec(`CREATE TABLE recent_contact_v3_table("40021" TEXT,"40010" INTEGER,"40027" INTEGER,"40003" INTEGER,"40050" INTEGER);
    CREATE TABLE c2c_msg_table("40001" INTEGER PRIMARY KEY,"40027" INTEGER,"40003" INTEGER,"40050" INTEGER,"40011" INTEGER,"40012" INTEGER,"40800" BLOB);
    CREATE INDEX c2c_seq ON c2c_msg_table("40027","40003");
    CREATE TABLE group_msg_table AS SELECT * FROM c2c_msg_table WHERE 0;
    CREATE INDEX group_seq ON group_msg_table("40027","40003");`);
  const now = Math.floor(Date.now() / 1000);
  sql.prepare(`INSERT INTO recent_contact_v3_table VALUES ('u_peer',1,21,18065,?)`).run(now);
  const insert = sql.prepare('INSERT INTO c2c_msg_table VALUES (?,?,?,?,?,?,?)');
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
  insert.run(10, 21, 18064, now - 60, 2, 1, new Uint8Array());
  insert.run(11, 21, 18065, now, 2, 1, new Uint8Array());
  insert.run(12, 21, 18064, now, 5, 12, poke('u_peer', 'u_self'));
  const recentContacts = new RecentContactDb(createSqliteStub(), { dbPath });
  const session = {
    context: { uin: '10001' },
    selfUid: 'u_self',
    recentContacts,
  } as AccountSession;
  const readWindow = vi.spyOn(recentContacts, 'recentInteractionWindow');
  let enabled = false;
  const badges = new ConversationInteractionBadges(session, statePath, () => enabled);
  const changed = vi.fn();
  badges.subscribe(changed);
  try {
    expect(readWindow).not.toHaveBeenCalled();
    enabled = true;
    emitSettingsChanged();
    await vi.waitFor(() => expect(readWindow).toHaveBeenCalledTimes(2));
    expect(changed.mock.calls).toEqual([[[]]]);

    insert.run(13, 21, 18065, now, 5, 12, poke('u_peer', 'u_self'));
    insert.run(14, 21, 18065, now, 5, 12, poke('u_self', 'u_peer'));
    insert.run(15, 21, 18065, now, 5, 12, poke('u_peer', 'u_third'));
    sql.prepare('UPDATE c2c_msg_table SET "40800"=? WHERE "40001"=10').run(
      codec.encode({
        elements: [
          {
            elementType: ElementType.GRAY_TIP,
            subType: GrayTipSubType.REVOKE,
            recallRevokeUid: 'u_peer',
          },
        ],
      }),
    );
    badges.requestScan();
    const newPoke = { kind: 'c2c', conv: 'u_peer', msgId: '13', action: 'poke' } as const;
    const recall = { ...newPoke, msgId: '10', action: 'recall' } as const;
    await vi.waitFor(() => {
      expect(changed.mock.calls.at(-1)?.[0]).toHaveLength(2);
      expect(changed.mock.calls.at(-1)?.[0]).toEqual(expect.arrayContaining([newPoke, recall]));
    });

    badges.acknowledge([conversationInteractionId(newPoke)]);
    expect(changed).toHaveBeenLastCalledWith([recall]);
    const reopened = new ConversationInteractionBadges(session, statePath, () => enabled);
    try {
      const restored = vi.fn();
      reopened.subscribe(restored);
      expect(restored).toHaveBeenLastCalledWith([recall]);
      reopened.observeRecall({ kind: 'c2c', conv: 'u_peer', msgId: '10', revokeUid: 'u_peer' });
      expect(restored).toHaveBeenCalledTimes(1);
      reopened.acknowledge([conversationInteractionId(recall)]);
      expect(restored).toHaveBeenLastCalledWith([]);
      reopened.observeRecall({ kind: 'c2c', conv: 'u_peer', msgId: '10', revokeUid: 'u_peer' });
      expect(restored).toHaveBeenCalledTimes(2);
    } finally {
      reopened.dispose();
    }
  } finally {
    badges.dispose();
    closeAllFixtureDbs();
    rmSync(dir, { recursive: true, force: true });
  }
});
