/**
 * Anti-recall trigger — STAGE 1 (interception only, no gray-tip re-insert yet).
 *
 * A QQ message recall rewrites the original row IN PLACE: it flips the scalar
 * columns to 40011=5 / 40012=4 and overwrites the 40800 body with a revoke
 * gray-tip. Probing the live DB (packages/db/test/probe_revoke_signature.ts)
 * proved that (40011=5, 40012=4) is a CLEAN, exclusive fingerprint of recall —
 * no non-recall message ever lands in that bucket — so the trigger needs no
 * protobuf parsing at all.
 *
 * This installer adds a BEFORE UPDATE trigger on each message table that fires
 * only on that transition and does `SELECT RAISE(IGNORE)`, which abandons just
 * that row's UPDATE. QQ's write returns "success" (no error → no crash), but
 * the original message text is left untouched on disk. WeQ (and QQ after a
 * restart) then always read the original.
 *
 * STAGE 1 deliberately does NOT insert a "以上消息已被拦截" gray tip — that
 * needs a crafted 40800 blob and must respect the UNIQUE indexes, so it's a
 * separate step. Here we only answer: does QQ tolerate a foreign trigger in
 * its schema and still boot cleanly?
 *
 *   ⚠️  RUN WITH QQ FULLY CLOSED. The script refuses otherwise and takes a
 *       full backup before touching anything.
 *
 * Run:
 *   pnpm tsx packages/db/test/anti_recall_trigger.ts status      # show state
 *   pnpm tsx packages/db/test/anti_recall_trigger.ts install     # backup + install
 *   pnpm tsx packages/db/test/anti_recall_trigger.ts uninstall   # remove triggers
 */

import { copyFileSync, existsSync, statSync } from 'node:fs';
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' };

const TABLES = ['c2c_msg_table', 'group_msg_table'] as const;
const trigName = (t: string) => `weq_anti_recall_${t === 'c2c_msg_table' ? 'c2c' : 'group'}`;

/**
 * Fire whenever QQ tries to REWRITE the message body (column 40800) in place.
 *
 * Observed on the live DB: a recall is NOT a single UPDATE. QQ first rewrites
 * 40800 (body → revoke gray-tip) while 40011 is still the original type, THEN
 * flips 40011/40012 → 5/4 in a separate write. A trigger gated only on the 5/4
 * fingerprint therefore catches the second write (type preserved) but misses
 * the first (body already clobbered) — exactly the "type kept, element changed"
 * symptom we hit.
 *
 * Since a stored message body is otherwise immutable, ANY 40800 change is a
 * recall (or an edit — which we also want to defeat). So we gate on
 * `NEW."40800" IS NOT OLD."40800"` (BLOB-safe, NULL-safe) and additionally keep
 * the 5/4 transition as a belt-and-suspenders guard for the type flip. Either
 * condition → `RAISE(IGNORE)` cancels that row's UPDATE, leaving the original
 * message fully intact on disk.
 *
 * ⚠️  This also blocks WeQ's OWN 40800 writes (updateMsgBody / edit-in-place).
 *     Acceptable for the anti-recall test; a production build would scope the
 *     trigger off while WeQ intentionally edits (e.g. a session flag column).
 */
function createTriggerSql(table: string): string {
  return `CREATE TRIGGER IF NOT EXISTS ${trigName(table)}
BEFORE UPDATE ON ${table}
WHEN NEW."40800" IS NOT OLD."40800"
  OR (NEW."40011" = 5 AND NEW."40012" = 4
      AND (IFNULL(OLD."40011", -1) <> 5 OR IFNULL(OLD."40012", -1) <> 4))
BEGIN
  SELECT RAISE(IGNORE);
END`;
}

async function assertQqClosed(): Promise<void> {
  const native = loadNative();
  const pids = native.ntHelper.getQqProcesses();
  if (pids.length > 0) {
    throw new Error(
      `QQ is still running (pids: ${pids.join(', ')}). Close QQ completely before installing — ` +
        `the write path needs the EXCLUSIVE lock and QQ must re-read the schema on next boot.`,
    );
  }
}

function backup(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = `${DB_PATH}.bak-${stamp}`;
  if (existsSync(dest)) throw new Error(`backup already exists: ${dest}`);
  const size = statSync(DB_PATH).size;
  console.log(`[backup] copying ${(size / 1e6).toFixed(0)} MB → ${dest}`);
  copyFileSync(DB_PATH, dest);
  console.log(`[backup] done.`);
  return dest;
}

function openDb(): QqDb {
  const native = loadNative();
  return new QqDb(native.ntHelper, { dbPath: DB_PATH, key: KEY, algo: ALGO });
}

async function status(db: QqDb): Promise<void> {
  const trig = await db.query(
    `SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'weq_anti_recall_%'`,
  );
  if (trig.length === 0) {
    console.log('[status] anti-recall triggers: NOT installed');
  } else {
    console.log(`[status] anti-recall triggers installed: ${trig.length}`);
    for (const t of trig) console.log(`   - ${String(t[0])} on ${String(t[1])}`);
  }
}

async function install(db: QqDb): Promise<void> {
  for (const table of TABLES) {
    const sql = createTriggerSql(table);
    console.log(`[install] ${trigName(table)} …`);
    await db.write(sql);
  }
  await status(db);
  console.log('\n✅ installed. Now start QQ and confirm it boots normally, then recall a test message.');
}

async function uninstall(db: QqDb): Promise<void> {
  for (const table of TABLES) {
    console.log(`[uninstall] DROP ${trigName(table)} …`);
    await db.write(`DROP TRIGGER IF EXISTS ${trigName(table)}`);
  }
  await status(db);
  console.log('\n✅ removed.');
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'status';
  const db = openDb();
  try {
    if (cmd === 'status') {
      await status(db);
      return;
    }
    if (cmd === 'install') {
      await assertQqClosed();
      backup();
      await install(db);
      return;
    }
    if (cmd === 'uninstall') {
      await assertQqClosed();
      await uninstall(db);
      return;
    }
    console.error(`unknown command: ${cmd}\nusage: status | install | uninstall`);
    process.exit(1);
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error('[anti-recall] failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
