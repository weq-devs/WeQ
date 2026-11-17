import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (!process.argv[2]) throw new Error('请传入本次构建的 nt_helper.node 绝对路径');
const nt = createRequire(import.meta.url)(resolve(process.argv[2]));
assert.equal(nt.getInitStatus(), 0);
const root = await mkdtemp(join(tmpdir(), 'weq-native-progress-'));
const source = join(root, 'synthetic.db');
const output = join(root, 'recovered.db');
const algo = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA1' };
const key = 'synthetic-progress-test-key';
try {
  await writeFile(source, '');
  await nt.executeSqlWriteWithKey(
    source,
    'CREATE TABLE synthetic(id INTEGER PRIMARY KEY, body TEXT)',
    key,
    algo,
  );
  for (let index = 0; index < 80; index++)
    await nt.executeSqlWrite(source, 'INSERT INTO synthetic(id, body) VALUES (?, ?)', [
      index,
      'synthetic'.repeat(240),
    ]);
  await nt.executeSqlWrite(source, 'CREATE INDEX synthetic_body ON synthetic(body)');
  nt.closeDb(source);
  const pages = [];
  const scan = await nt.scanBadPages(source, key, algo, (error, tick) => {
    assert.equal(error, null);
    pages.push(tick);
  });
  const healthTicks = [];
  const healthBeforeResult = [];
  let healthSettled = false;
  const health = await nt.checkDatabaseHealth(source, key, algo, (error, tick) => {
    assert.equal(error, null);
    healthTicks.push(tick);
    if (!healthSettled) healthBeforeResult.push(tick);
  });
  healthSettled = true;
  const recover = [];
  const report = await nt.recoverDatabase(
    { dbPath: source, outPath: output, workDir: join(root, 'work'), key, algo },
    (error, tick) => {
      assert.equal(error, null);
      recover.push(tick);
    },
  );
  await new Promise((done) => setImmediate(done));
  assert.equal(health.healthy, true);
  assert.ok(healthTicks.some((tick) => tick.step === 'integrity'));
  assert.ok(
    healthBeforeResult.some((tick) => tick.unit === 'records'),
    '结果返回前应已收到库内记录进度',
  );
  assert.ok(
    healthTicks.some(
      (tick) => tick.step === 'integrity-pages' && tick.completed === tick.total && tick.total > 0,
    ),
  );
  assert.ok(
    healthTicks.some(
      (tick) =>
        tick.step.startsWith('integrity-records-') &&
        tick.objectName === 'synthetic' &&
        tick.completed === 80 &&
        tick.total === 80 &&
        tick.unit === 'records',
    ),
  );
  assert.ok(
    healthTicks.some(
      (tick) =>
        tick.step.startsWith('integrity-index-') &&
        tick.objectName === 'synthetic_body' &&
        tick.completed === tick.total,
    ),
  );
  assert.equal(pages.at(-1)?.completed, scan.pageCount);
  assert.equal(pages.at(-1)?.total, scan.pageCount);
  for (const step of ['pages', 'decrypt', 'output-pages', 'output-integrity'])
    assert.ok(
      recover.some((tick) => tick.detail?.step === step),
      step,
    );
  assert.equal(report.verification.healthy, true);
  assert.equal(
    (await nt.executeSqlWithKey(output, 'SELECT count(*) FROM synthetic', key, algo))[0][0],
    80n,
  );
  console.log(
    JSON.stringify({
      pageCounts: true,
      healthCallbacks: true,
      recoverSteps: [
        ...new Set(recover.flatMap((tick) => (tick.detail ? [tick.detail.step] : []))),
      ],
      rowsPreserved: 80,
      sourcePages: scan.pageCount,
    }),
  );
} finally {
  nt.closeDb(source);
  nt.closeDb(output);
  await rm(root, { recursive: true, force: true });
}
