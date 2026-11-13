import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AccountSession } from '@weq/account';
import { C2cMsgDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import {
  readonlyConversationPage,
  type ReadonlyMessageCursor,
} from '../src/account/readonly_conversation';
import { OfficialAccountService } from '../src/account/official_account';
import { ServiceAccountService } from '../src/account/service_account';

const dirs: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'weq-readonly-page-'));
  dirs.push(dir);
  const path = join(dir, 'msg.db');
  const sql = fixtureDb(path);
  const columns =
    '"40001" INTEGER,"40002" INTEGER,"40003" INTEGER,"40005" INTEGER,"40011" INTEGER,"40012" INTEGER,"40013" INTEGER,"40020" TEXT,"40021" TEXT,"40027" INTEGER,"40030" INTEGER,"40033" INTEGER,"40035" INTEGER,"40050" INTEGER,"40062" BLOB,"40800" BLOB,"40801" BLOB';
  sql.exec(
    `CREATE TABLE c2c_msg_table (${columns}); CREATE TABLE service_assistant_msg_table (${columns}); CREATE INDEX c2c_uid ON c2c_msg_table("40021");`,
  );
  for (const table of ['c2c_msg_table', 'service_assistant_msg_table'])
    sql.exec(
      `INSERT INTO ${table} ("40001","40003","40021","40035","40050") VALUES (-3,NULL,'u_official',77,100),(-2,0,'u_official',77,100),(1,4,'u_official',77,200),(2,4,'u_official',77,200),(3,5,'u_official',77,300),(99,9,'u_other',88,400);`,
    );
  const db = new C2cMsgDb(createSqliteStub(), { dbPath: path });
  const serviceDb = new C2cMsgDb(createSqliteStub(), {
    dbPath: path,
    table: 'service_assistant_msg_table',
  });
  const session = {
    c2cMsgs: db,
    serviceAssistantMsgs: serviceDb,
    uidMap: { sortNoByUid: () => undefined },
    recentContacts: {
      getRecentContact: async () => [
        {
          chatType: 103,
          targetUid: 'u_official',
          targetDisplayName: '公众号',
          targetUin: 77n,
          sendTime: 300n,
        },
      ],
    },
    serviceAssistantContacts: {
      listContacts: async () => [{ appId: 77n, displayName: '服务号', avatarUrl: null }],
    },
    profileInfo: { getProfile: async () => null },
  } as unknown as AccountSession;
  return session;
}
it.each(['official', 'service'] as const)(
  '只读 %s 分页覆盖重号、零/NULL 序号和负消息ID，不混入其他分区',
  async (kind) => {
    const session = fixture();
    const target = kind === 'official' ? { kind, peerUid: 'u_official' } : { kind, appId: '77' };
    let cursor: ReadonlyMessageCursor | undefined;
    const ids: string[] = [];
    for (;;) {
      const page = await readonlyConversationPage(session, target, { limit: 2, cursor });
      ids.push(...page.items.map((row) => String(row.msgId)));
      if (!page.hasMore) break;
      cursor = page.nextCursor ?? undefined;
    }
    expect(ids).toEqual(['3', '2', '1', '-2', '-3']);
  },
);
it('锚点读取和双向分页保留原消息身份，缺失锚点不冒充空会话', async () => {
  const session = fixture();
  const target = { kind: 'official' as const, peerUid: 'u_official' };
  const page = await readonlyConversationPage(session, target, { anchorId: '1', limit: 3 });
  expect(page.items.some((row) => row.msgId === 1n)).toBe(true);
  const newer = await readonlyConversationPage(session, target, {
    cursor: { msgSeq: '4', sendTime: '200', msgId: '1' },
    direction: 'newer',
    limit: 2,
  });
  expect(newer.items.map((row) => row.msgId)).toEqual([3n, 2n]);
  expect((await readonlyConversationPage(session, target, { anchorId: '99' })).found).toBe(false);
});
it('目录不再要求最新记录含Ark或prompt，消息为空也保留已登记来源', async () => {
  const session = fixture();
  expect(
    (await new OfficialAccountService(session).listAccounts()).map((row) => row.peerUid),
  ).toEqual(['u_official']);
  expect((await new ServiceAccountService(session).listAccounts()).map((row) => row.appId)).toEqual(
    ['77'],
  );
});
