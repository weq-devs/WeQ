/**
 * Integration test for `BuddyMsgFtsDb` end-to-end (the full-text-search index).
 *
 * Run:  pnpm --filter @weq/db test:msg-fts -- <keyword>
 *   or: WEQ_TEST_KEYWORD=分期 pnpm --filter @weq/db test:msg-fts
 *
 * Points at buddy_msg_fts.db (NOT nt_msg.db) — it sits in the same nt_db folder.
 */

import { loadNative } from '@weq/native';
import { BuddyMsgFtsDb } from '../src/msg/buddy_msg_fts';

const DB_PATH =
  process.env.WEQ_TEST_FTS_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\buddy_msg_fts.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
// pnpm forwards a literal `--` separator into argv; drop it before reading.
const KEYWORD =
  process.argv.slice(2).find((a) => a !== '--') ?? process.env.WEQ_TEST_KEYWORD ?? '你好';

async function main(): Promise<void> {
  const native = loadNative();
  const db = new BuddyMsgFtsDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  console.log(`[test:msg-fts] opening ${DB_PATH}`);
  console.log(`[test:msg-fts] searching for "${KEYWORD}"`);
  const hits = await db.search(KEYWORD, 10);
  console.log(`[test:msg-fts] → ${hits.length} hit(s)`);

  console.log(JSON.stringify(hits, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

  // A blank keyword must short-circuit to no hits without touching the db.
  const blank = await db.search('   ', 10);
  console.log(`[test:msg-fts] blank keyword → ${blank.length} hit(s) (expect 0)`);

  db.close();
}

main().catch((e) => {
  console.error('[test:msg-fts] failed:', e);
  process.exit(1);
});
