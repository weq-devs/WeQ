import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSqliteStub, fixtureDb, closeAllFixtureDbs } from '@weq/testkit';
import { UidMap, UidMappingDb } from '../src/contact/uid_mapping';
import { scheduleDatabase, withDatabasePriority } from '../src/query_schedule';
const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('账号打开后新增的映射能按需补查，成功后常驻复用；真正缺失时不猜分区', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-uid-late-'));
  roots.push(root);
  const path = join(root, 'fixture.db'),
    sql = fixtureDb(path);
  sql.exec('CREATE TABLE nt_uid_mapping_table ("48901" INTEGER,"48902" TEXT,"1002" INTEGER)');
  const db = new UidMappingDb(createSqliteStub(), { dbPath: path });
  const resolve = vi.fn((uid: string) => db.findByUid(uid));
  const map = UidMap.from(await db.listAll(), resolve);
  expect(await map.resolveSortNo('u_new')).toBeUndefined();
  sql.exec("INSERT INTO nt_uid_mapping_table VALUES (17,'u_new',20002)");
  expect(await map.resolveSortNo('u_new')).toBe(17n);
  expect(await map.resolveSortNo('u_new')).toBe(17n);
  expect(map.uidByUin(20002n)).toBe('u_new');
  expect(resolve).toHaveBeenCalledTimes(2);
  sql.exec(
    "INSERT INTO nt_uid_mapping_table VALUES (18,'u_ambiguous',20003),(19,'u_ambiguous',20003),(0,'u_invalid',20004)",
  );
  expect(await db.findByUid('u_ambiguous')).toBeUndefined();
  expect(await db.findByUid('u_invalid')).toBeUndefined();
});
it('同 UID 并发补查合并，错误身份和无效分区不写入映射', async () => {
  let finish!: (row: { uid: string; uin: bigint; sortNo: bigint }) => void;
  const resolve = vi.fn(
    () =>
      new Promise<{ uid: string; uin: bigint; sortNo: bigint }>((done) => {
        finish = done;
      }),
  );
  const map = UidMap.from([], resolve);
  const first = map.resolveSortNo('u_a'),
    second = map.resolveSortNo('u_a');
  finish({ uid: 'u_b', uin: 2n, sortNo: 7n });
  expect(await Promise.all([first, second])).toEqual([undefined, undefined]);
  expect(resolve).toHaveBeenCalledOnce();
  expect(map.size).toBe(0);
});
it('独立窗口的补查取消互不传播，同一个窗口内部仍可合并', async () => {
  const path = '/synthetic/uid-signal.db';
  let release!: () => void;
  const running = scheduleDatabase(
    path,
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const resolve = vi.fn((uid: string) =>
    scheduleDatabase(path, async () => ({ uid, sortNo: 17n, uin: 20002n })),
  );
  const map = UidMap.from([], resolve);
  const a = new AbortController(),
    b = new AbortController();
  const first = withDatabasePriority('background', () => map.resolveSortNo('u_new'), a.signal);
  const failed = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const second = withDatabasePriority('interactive', () => map.resolveSortNo('u_new'), b.signal);
  a.abort();
  release();
  await Promise.all([running, failed]);
  expect(await second).toBe(17n);
});
