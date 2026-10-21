import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSqliteStub, fixtureDb, closeAllFixtureDbs } from '@weq/testkit';
import { GuildDirectMsgDb } from '@weq/db';
import type { AccountSession } from '@weq/account';
import { GuildDirectService } from '../src/account/guild_direct';
import { GuildMsgSource, type GuildExportTaskMeta } from '../src/account/export/guild_source';
import { iterateC2cMessages } from '../src/account/export/message_source';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';

let root = '';
afterEach(() => {
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
});
const meta: GuildExportTaskMeta = {
  nodeId: '100',
  peerTinyId: '2',
  guildId: '3',
  guildName: '合成频道',
  peerNick: '合成好友',
  peerAvatarUrl: null,
  selfTinyId: '4',
  selfNick: '自己',
  selfUin: '',
  selfUid: '',
  selfAvatarUrl: null,
};
it('真实 SQLite 的同 seq 与 NULL seq 进入频道搜索、上下文和精确导出，不沿用旧 seq 游标丢行', async () => {
  root = mkdtempSync(join(tmpdir(), 'weq-guild-stable-export-'));
  const path = join(root, 'guild_msg.db');
  const sql = fixtureDb(path);
  sql.exec(
    'CREATE TABLE guild_msg_table ("40001" INTEGER PRIMARY KEY,"40003" INTEGER,"40027" INTEGER,"40026" INTEGER,"40025" TEXT,"40013" INTEGER,"40050" INTEGER,"40800" BLOB,"40011" INTEGER,"40012" INTEGER,"40801" BLOB)',
  );
  const add = sql.prepare(
    'INSERT INTO guild_msg_table ("40001","40003","40027","40050") VALUES (?,?,?,?)',
  );
  add.run(-5, null, 100, null);
  add.run(1, 1, 100, 1);
  add.run(2, 1, 100, 1);
  add.run(3, 0, 999, 0);
  const db = new GuildDirectMsgDb(createSqliteStub(), { dbPath: path });
  const svc = new GuildDirectService({
    msgDbPath: join(root, 'msg.db'),
    guildDirectMsgs: db,
    guildDirectNodes: {
      listSessions: async () => [
        {
          nodeId: 100n,
          peerTinyId: 2n,
          nickChannel: '合成好友',
          nickGlobal: '',
          guildName: '合成频道',
          lastSeq: 1n,
          lastTime: 1n,
        },
      ],
    },
  } as unknown as AccountSession);
  const legacy = new GuildMsgSource(svc, meta);
  Object.defineProperty(legacy, 'exportC2cMessages', { value: undefined });
  const oldIds: string[] = [];
  for await (const row of iterateC2cMessages(legacy as unknown as MsgService, '2', { pageSize: 1 }))
    oldIds.push(String(row.msgId));
  expect(oldIds).toEqual(['1']);
  const source = new GuildMsgSource(svc, meta);
  const ids: string[] = [];
  for await (const row of iterateC2cMessages(source as unknown as MsgService, '2', { pageSize: 1 }))
    ids.push(String(row.msgId));
  expect(ids).toEqual(['-5', '1', '2']);
  expect((await svc.search('合成', 10)).total).toBe(3);
  expect((await svc.aroundMessage('100', '-5')).found).toBe(true);
  const manager = new ExportTaskManager({} as MsgService, join(root, 'exports'), {
    guildDirect: svc,
  });
  const id = await manager.startTask({
    kind: 'c2c',
    conv: '2',
    name: '精确频道',
    format: 'json',
    total: 2,
    guild: meta,
    filter: { messageIds: ['-5', '2'] },
  });
  for (let i = 0; i < 400 && !['completed', 'failed'].includes(manager.getTask(id)!.status); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const task = manager.getTask(id)!;
  expect(task.error).toBeUndefined();
  expect(task.current).toBe(2);
  const data = JSON.parse(readFileSync(task.filePath!, 'utf8'));
  expect(
    (Array.isArray(data) ? data : data.messages).map((row: { msgId: string }) => row.msgId),
  ).toEqual(['-5', '2']);
  expect(JSON.parse(readFileSync(task.reportPath!, 'utf8')).guild).toMatchObject({
    kind: 'guild-direct',
    nodeId: '100',
    peerTinyId: '2',
  });
});
