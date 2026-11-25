import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
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
  'scanBadPagesFrom',
  'assessDatabaseQuickRepair',
  'repairDatabaseQuick',
  'cloneDatabaseRepairBackup',
  'recoverDatabaseStreaming',
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

async function verifyRepairCapabilities(directory, algo) {
  const dbPath = join(directory, 'repair-source.db');
  const backup = join(directory, 'repair-backup.db');
  const outPath = join(directory, 'repair-streaming.db');
  const key = 'weq-release-fixture';
  const header = Buffer.alloc(1024);
  header.write('SQLite header 3\0');
  header.write('QQ_NT DB', 32);
  await writeFile(dbPath, header);
  await nt.executeSqlWriteWithKey(dbPath, 'CREATE TABLE probe(n INTEGER)', key, algo);
  await nt.executeSqlWriteWithKey(dbPath, 'INSERT INTO probe VALUES(42)', key, algo);
  nt.closeDb(dbPath);

  const fullScan = await nt.scanBadPages(dbPath, key, algo);
  const checkpoints = [];
  const resumed = await nt.scanBadPagesFrom(dbPath, key, algo, 2, null, (error, value) => {
    if (!error) checkpoints.push(value);
  });
  await setImmediate();
  assert.equal(fullScan.usedHmac, true);
  assert.deepEqual(resumed.badPages, []);
  assert.equal(resumed.pageCount, fullScan.pageCount);
  assert.equal(checkpoints[0]?.firstPage, 2);
  assert.equal(checkpoints.at(-1)?.nextPage, fullScan.pageCount + 1);

  const original = await readFile(dbPath);
  const progress = [];
  const report = await nt.recoverDatabaseStreaming(
    { dbPath, outPath, workDir: directory, key, algo, sourceScan: fullScan },
    (error, value) => {
      if (!error && value.rebuiltBytes > 0) progress.push(value.rebuiltBytes);
    },
  );
  await setImmediate();
  assert.equal(report.verification.healthy, true);
  assert.deepEqual(await nt.executeSqlWithKey(outPath, 'SELECT n FROM probe', key, algo), [[42n]]);
  nt.closeDb(outPath);
  assert.equal(progress.at(-1), (await readFile(outPath)).length - header.length);
  assert.deepEqual(await readFile(dbPath), original);

  await copyFile(dbPath, backup);
  const damaged = Buffer.from(original);
  // SHA1 页的最后 48 字节是保留区，前 16 字节是 IV。损坏签名，保留密文和 IV。
  const pageTwoSignature = header.length + 2 * fullScan.pageSize - 48 + 16;
  damaged[pageTwoSignature] ^= 0xff;
  await writeFile(dbPath, damaged);
  const scan = await nt.scanBadPages(dbPath, key, algo);
  assert.deepEqual(scan.badPages, [2]);
  const quick = await nt.assessDatabaseQuickRepair(dbPath, key, algo, scan, 'qq', [backup]);
  assert.deepEqual(quick.evidence?.backupMatches, [2]);
  if (quick.budgetBytes === undefined) {
    // 某些 runner 的临时卷不支持原生克隆，仍须正确返回已核验但无法克隆。
    assert.equal(quick.failure, 'clone-unavailable');
  } else {
    const quickPath = join(directory, 'repair-quick.db');
    const result = await nt.repairDatabaseQuick(
      { dbPath, outPath: quickPath, workDir: directory, key, algo, sourceScan: scan },
      [backup],
    );
    assert.equal(result.verification.healthy, true);
    assert.deepEqual(await nt.executeSqlWithKey(quickPath, 'SELECT n FROM probe', key, algo), [
      [42n],
    ]);
    nt.closeDb(quickPath);
  }
  assert.deepEqual(await readFile(dbPath), damaged);
  return quick.budgetBytes !== undefined;
}

try {
  process.env.WEQ_LOG_DIR = root;
  nt.setLogPath(join(root, 'maintenance-native.log'));
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
  const cloned = await verifyRepairCapabilities(root, target.algo);
  console.log(
    `PASS 配套 native 与维护进程：加锁、扫描续作、流式重建、${cloned ? '同卷快修' : '无克隆时正确回退'}、冷启动 WAL`,
  );
} finally {
  await lock?.terminate();
  if (barrier) nt.setDatabaseMaintenanceWriteBarrier(id, [dbPath], false);
  nt.closeAllDb();
  await rm(root, { recursive: true, force: true });
}
