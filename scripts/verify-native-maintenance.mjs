import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tsImport } from 'tsx/esm/api';

const workers = resolve(process.argv[2] ?? 'apps/desktop/out/main');
const nativeRoot = resolve(process.argv[3] ?? 'native');
const require = createRequire(import.meta.url);
const nt = require(join(nativeRoot, process.platform, process.arch, 'nt_helper.node'));
assert.equal(nt.getInitStatus(), 0, '维护预检无法加载 native');
for (const name of [
  'beginDatabaseMaintenance',
  'endDatabaseMaintenance',
  'protectDatabaseMaintenanceProduct',
  'setDatabaseMaintenanceWriteBarrier',
]) {
  assert.equal(typeof nt[name], 'function', `缺少 ${name}，请更新配套 native 版本锚`);
}
const { DatabaseMaintenanceLock } = await tsImport(
  '../apps/desktop/src/main/db_maintenance_lock.ts',
  import.meta.url,
);
const { runDatabaseMaintenanceWorker } = await tsImport(
  '../apps/desktop/src/main/db_maintenance_worker_client.ts',
  import.meta.url,
);
const root = await mkdtemp(join(tmpdir(), 'weq-native-maintenance-'));
const dbName = 'probe.db';
const dbPath = join(root, dbName);
const product = join(root, 'product.db');
const id = randomUUID();
let lock;
let barrier = false;

function withDb(run, path = dbPath, options = {}) {
  const db = new DatabaseSync(path, options);
  try {
    db.exec('PRAGMA busy_timeout=0');
    return run(db);
  } finally {
    db.close();
  }
}

try {
  withDb((db) => {
    db.exec('PRAGMA page_size=4096; CREATE TABLE probe(n); INSERT INTO probe VALUES(1);');
  });
  await copyFile(dbPath, product);
  const target = {
    dbName,
    dbPath,
    dbDir: root,
    uin: '10000',
    key: '',
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  };
  nt.setDatabaseMaintenanceWriteBarrier(id, [dbPath], true);
  barrier = true;
  const lockOptions = {
    workerPath: join(workers, 'dbMaintenanceLockWorker.mjs'),
    nativeRoot,
  };
  lock = new DatabaseMaintenanceLock(lockOptions);
  const locked = await lock.begin(id, [target], AbortSignal.timeout(20_000));
  assert.equal(locked[0]?.error, undefined);
  const scan = await runDatabaseMaintenanceWorker(
    { kind: 'scan', target },
    AbortSignal.timeout(20_000),
    () => {},
    { workerPath: join(workers, 'dbMaintenanceWorker.mjs'), nativeRoot },
  );
  assert.equal(scan.plaintext, true);
  assert.ok(scan.pageCount >= 2);
  await lock.protect(dbPath, product);
  withDb((db) => {
    assert.equal(db.prepare('SELECT n FROM probe').get().n, 1);
    assert.throws(() => db.exec('INSERT INTO probe VALUES(2)'), /database is locked/i);
  });
  await lock.end();
  withDb((db) => db.exec('INSERT INTO probe VALUES(2)'));

  const walPath = join(root, 'cold-wal.db');
  withDb((db) => {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE probe(n); INSERT INTO probe VALUES(1);');
  }, walPath);
  lock = new DatabaseMaintenanceLock(lockOptions);
  const wal = await lock.begin(
    randomUUID(),
    [{ ...target, dbName: 'cold-wal.db', dbPath: walPath }],
    AbortSignal.timeout(20_000),
  );
  assert.equal(wal.length, 1);
  assert.equal(wal[0]?.error, undefined);
  withDb((db) => assert.equal(db.prepare('SELECT n FROM probe').get().n, 1), walPath, {
    readOnly: true,
  });
  withDb(
    (db) => assert.throws(() => db.exec('INSERT INTO probe VALUES(2)'), /database is locked/i),
    walPath,
  );
  await lock.end();
  withDb((db) => db.exec('INSERT INTO probe VALUES(2)'), walPath);
  console.log('PASS 配套 native 与维护进程：加锁、扫描、保护产物、冷启动 WAL 只读、解锁');
} finally {
  await lock?.terminate();
  if (barrier) nt.setDatabaseMaintenanceWriteBarrier(id, [dbPath], false);
  await rm(root, { recursive: true, force: true });
}
