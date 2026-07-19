/**
 * Confirm whether column 180015 (content summary) is a tagged union keyed by
 * content type: enumerate, per collection `type` (col 180002), which inner
 * sub-tag(s) appear inside blob 180015.
 *
 * Run:  pnpm tsx ./packages/db/test/probe_collection_union.ts
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { decode } from '@weq/codec/raw';
import { testEnv, qqDbPath } from '@weq/testkit';

const KEY = testEnv.key;
const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  qqDbPath('collection.db');

async function main() {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });
  const rows = await db.query(
    `SELECT "180001","180002","180015" FROM "collection_list_info_table"`,
  );
  const map = new Map<string, number>();
  for (const r of rows) {
    const type = r[1];
    const blob = r[2];
    let sub = '(no-blob)';
    if (blob instanceof Uint8Array) {
      const f = decode(blob);
      const inner = f[0]?.guesses.find((g) => g.kind === 'len-nested');
      if (inner && inner.kind === 'len-nested') {
        sub = inner.value.map((x) => String(x.tag)).join(',');
      } else sub = '(flat)';
    }
    const key = `type=${type}  180015-subtags=[${sub}]`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  console.log('=== type -> 180015 inner sub-tag(s) ===');
  [...map.entries()].sort().forEach(([k, n]) => {
    console.log(`  ${String(n).padStart(2)}x  ${k}`);
  });
  db.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
