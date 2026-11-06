import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { AntiRecallService } from '../src/account/anti_recall';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('私聊页合并撤回查询，正文返回前仍带齐数据线兼容标记', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-recall-page-'));
  roots.push(root);
  const dbPath = join(root, 'msg.db');
  fixtureDb(dbPath).exec(`CREATE TABLE weq_recall_log (
    msgid INTEGER PRIMARY KEY, conv TEXT, table_kind TEXT, sender_uid TEXT, revoke_uid TEXT,
    orig_seq INTEGER, recall_ts INTEGER);
    INSERT INTO weq_recall_log VALUES
      (1,'u_peer','c2c','u_sender','u_revoker',1,10),
      (2,'u_peer','dataline','u_sender','u_revoker',2,20),
      (3,'u_peer','group','u_sender','u_revoker',3,30),
      (4,'u_other','c2c','u_sender','u_revoker',4,40)`);
  const nt = createSqliteStub();
  const execute = vi.spyOn(nt, 'executeSql');
  const service = new AntiRecallService(
    { msgDbPath: dbPath, context: { dbKey: '', algos: {} } } as AccountSession,
    { native: { ntHelper: nt } } as Platform,
    join(root, 'config.json'),
  );
  const map = await service.getRecallMap('c2c', 'u_peer', [1n, 2n, 3n, 4n]);
  expect([...map.keys()].sort()).toEqual(['1', '2']);
  expect(map.get('2')).toEqual({ senderUid: 'u_sender', revokeUid: 'u_revoker', recallTs: 20 });
  expect(execute).toHaveBeenCalledTimes(2);
  execute.mockClear();
  expect([...(await service.getRecallMap('group', 'u_peer', [1n, 3n])).keys()]).toEqual(['3']);
  expect(execute).toHaveBeenCalledTimes(2);
});
