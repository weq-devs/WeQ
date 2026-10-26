import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupMsgDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { DeletedMsgStore } from '../src/account/deleted_msgs';
import { MsgService } from '../src/account/msg';

const fault = vi.hoisted(() => ({ code: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (fault.code && typeof args[0] === 'number')
        throw Object.assign(new Error('合成写盘故障'), { code: fault.code });
      return fs.writeFileSync(...args);
    },
  };
});
const roots: string[] = [];
const dbs: GroupMsgDb[] = [];
afterEach(() => {
  fault.code = '';
  for (const db of dbs.splice(0)) db.close();
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-delete-journal-'));
  roots.push(root);
  const dbPath = join(root, 'msg.db');
  const sql = fixtureDb(dbPath);
  sql.exec(
    'CREATE TABLE group_msg_table ("40001" INTEGER, "40011" INTEGER, "40012" INTEGER, "40800" BLOB)',
  );
  sql
    .prepare('INSERT INTO group_msg_table VALUES (?, ?, ?, ?)')
    .run(123n, 2n, 16n, new Uint8Array([1, 2]));
  const db = new GroupMsgDb(createSqliteStub(), { dbPath, key: 'synthetic', algo: {} });
  dbs.push(db);
  const path = join(root, 'deleted.json');
  const store = new DeletedMsgStore(path);
  const session = {
    c2cMsgs: { readMsgType: async () => null },
    datalineMsgs: { readMsgType: async () => null },
    groupMsgs: db,
  } as unknown as ConstructorParameters<typeof MsgService>[0];
  return { root, path, db, store, service: new MsgService(session, store) };
}

it.each(['ENOSPC', 'EACCES', 'EIO'])(
  'does not change SQLite or memory when recovery persistence fails with %s',
  async (code) => {
    const f = fixture();
    fault.code = code;
    await expect(f.service.deleteMessage(123n, 'group', '777')).rejects.toThrow();
    expect(await f.db.readMsgType(123n)).toEqual({ msgType: 2n, subType: 16n });
    expect(f.store.get('123')).toBeUndefined();
    expect(new DeletedMsgStore(f.path).get('123')).toBeUndefined();
  },
);

it('keeps the durable original types when the database write fails and permits restart/restore', async () => {
  const f = fixture();
  const write = vi.spyOn(f.db, 'writeMsgType').mockRejectedValueOnce(new Error('合成数据库故障'));
  await expect(f.service.deleteMessage(123n, 'group', '777')).rejects.toThrow('合成数据库故障');
  expect(new DeletedMsgStore(f.path).get('123')).toMatchObject({
    origMsgType: '2',
    origSubType: '16',
  });
  write.mockRestore();
  expect(await f.service.deleteMessage(123n, 'group', '777')).toBe(true);
  expect(await f.service.restoreMessage(123n)).toBe(true);
  expect(await f.db.readMsgType(123n)).toEqual({ msgType: 2n, subType: 16n });
});

it('preserves damaged recovery records instead of overwriting them', () => {
  const f = fixture();
  writeFileSync(f.path, '{damaged');
  expect(() => new DeletedMsgStore(f.path)).toThrow();
  expect(readFileSync(f.path, 'utf8')).toBe('{damaged');
});

it('keeps recovery information if forgetting a restored message fails, allowing a safe retry after restart', async () => {
  const f = fixture();
  expect(await f.service.deleteMessage(123n, 'group', '777')).toBe(true);
  fault.code = 'EIO';
  await expect(f.service.restoreMessage(123n)).rejects.toThrow();
  expect(await f.db.readMsgType(123n)).toEqual({ msgType: 2n, subType: 16n });
  expect(f.store.get('123')).toBeDefined();
  expect(new DeletedMsgStore(f.path).get('123')).toBeDefined();
  fault.code = '';
  expect(await f.service.restoreMessage(123n)).toBe(true);
  expect(new DeletedMsgStore(f.path).get('123')).toBeUndefined();
});

it('serializes overlapping delete and restore so the recovery journal cannot be removed before a late delete', async () => {
  const f = fixture();
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.db.writeMsgType.bind(f.db);
  vi.spyOn(f.db, 'writeMsgType').mockImplementationOnce(async (...args) => {
    started();
    await gate;
    return original(...args);
  });
  const deletion = f.service.deleteMessage(123n, 'group', '777');
  await entered;
  const restoration = f.service.restoreMessage(123n);
  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  expect(await deletion).toBe(true);
  expect(await restoration).toBe(true);
  expect(await f.db.readMsgType(123n)).toEqual({ msgType: 2n, subType: 16n });
  expect(new DeletedMsgStore(f.path).get('123')).toBeUndefined();
});
