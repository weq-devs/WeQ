/**
 * Verify the CollectionDb layer end-to-end: decode every row via the lenient
 * assembler (incl. the trailing-padded location type) and print one sample per
 * type. Also exercises pagination.
 *
 * Run:  pnpm tsx ./packages/db/test/verify_collection_db.ts
 */
import { loadNative } from '@weq/native';
import { CollectionDb } from '../src/collection';
import { testEnv, qqDbPath } from '@weq/testkit';

const KEY = testEnv.key;
const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  qqDbPath('collection.db');

function safe(_k: string, v: unknown) {
  if (typeof v === 'bigint') return `${v}n`;
  if (v instanceof Uint8Array) return `<${Buffer.from(v).toString('hex')}>`;
  return v;
}

async function main() {
  const native = loadNative();
  const db = new CollectionDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const total = await db.count();
  console.log(`total collected: ${total}`);

  // paginate through everything in pages of 20
  const all = [];
  for (let off = 0; off < total; off += 20) {
    const page = await db.listAll(20, off);
    all.push(...page);
  }
  console.log(`paged rows: ${all.length}`);

  const seen = new Set<number>();
  for (const it of all) {
    if (seen.has(it.type)) continue;
    seen.add(it.type);
    console.log(`\n#### type=${it.type} kind=${it.kind} cid=${it.cid.slice(0, 20)} collect=${new Date(it.collectTime).toISOString()}`);
    console.log('  author :', JSON.stringify(it.author, safe));
    console.log('  summary:', JSON.stringify(it.summary, safe).slice(0, 500));
  }

  db.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
