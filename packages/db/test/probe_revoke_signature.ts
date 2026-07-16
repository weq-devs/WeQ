/**
 * Probe: can a message "撤回" (recall) be distinguished from every other
 * message by SCALAR columns alone — i.e. WITHOUT decoding the 40800 blob?
 *
 * A recall rewrites the original row in place: QQ turns it into a gray-tip
 * (elementType=8 / subType=4) revoke element inside 40800. The question that
 * decides whether a SQLite BEFORE UPDATE trigger needs to parse protobuf is:
 *
 *   1. Do recall gray-tips carry a unique scalar fingerprint (40011/40012/…)?
 *   2. Do OTHER, non-recall messages ever share that same fingerprint?
 *      (If a normal msg can legitimately become 40011=GrayTip, the trigger
 *       would false-positive on it.)
 *
 * Strategy: we can't easily find "known recalls" without decoding, so we
 * decode the body for a sample, bucket every row by (40011,40012), and for the
 * gray-tip buckets report which ones actually decode to a `grayTipRevoke`
 * element vs other gray tips. Then we know if (40011,40012) alone is enough.
 *
 * Run:  pnpm tsx packages/db/test/probe_revoke_signature.ts [table] [limit]
 *   table:  group_msg_table (default) | c2c_msg_table
 *   limit:  rows to scan (default 20000)
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { decodeBody } from '../src/msg/util';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

const TABLE = process.argv[2] ?? 'group_msg_table';
const LIMIT = Number(process.argv[3] ?? 20000);

interface Bucket {
  total: number;
  revokeGrayTip: number; // decodes to a grayTipRevoke element
  otherGrayTip: number; // elementType=8 but not subType revoke
  nonGrayTip: number; // no elementType=8 at all
  sampleMsgIds: bigint[];
}

function bucketKey(t: unknown, s: unknown): string {
  return `${t ?? 'NULL'}/${s ?? 'NULL'}`;
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  console.log(`[probe] table=${TABLE} limit=${LIMIT}\n`);

  const rows = await db.query(
    `SELECT "40001","40011","40012","40800"
       FROM ${TABLE}
      ORDER BY rowid DESC
      LIMIT ?`,
    [BigInt(LIMIT)],
  );

  const buckets = new Map<string, Bucket>();

  for (const r of rows) {
    const msgId = r[0] as bigint;
    const key = bucketKey(r[1], r[2]);
    let b = buckets.get(key);
    if (!b) {
      b = { total: 0, revokeGrayTip: 0, otherGrayTip: 0, nonGrayTip: 0, sampleMsgIds: [] };
      buckets.set(key, b);
    }
    b.total++;

    const els = decodeBody(r[3]);
    const hasGrayTip = els.some((e) => e.kind?.startsWith('grayTip'));
    const hasRevoke = els.some((e) => e.kind === 'grayTipRevoke');
    if (hasRevoke) {
      b.revokeGrayTip++;
      if (b.sampleMsgIds.length < 5) b.sampleMsgIds.push(msgId);
    } else if (hasGrayTip) {
      b.otherGrayTip++;
    } else {
      b.nonGrayTip++;
    }
  }

  // Sort buckets: those containing any revoke first.
  const sorted = [...buckets.entries()].sort(
    (a, b) => b[1].revokeGrayTip - a[1].revokeGrayTip,
  );

  console.log(
    '(40011/40012)'.padEnd(16) +
      'total'.padEnd(9) +
      'revoke'.padEnd(9) +
      'otherGT'.padEnd(9) +
      'normal'.padEnd(9) +
      'sample msgIds (revoke)',
  );
  console.log('-'.repeat(90));
  for (const [key, b] of sorted) {
    console.log(
      key.padEnd(16) +
        String(b.total).padEnd(9) +
        String(b.revokeGrayTip).padEnd(9) +
        String(b.otherGrayTip).padEnd(9) +
        String(b.nonGrayTip).padEnd(9) +
        (b.sampleMsgIds.length ? b.sampleMsgIds.join(', ') : ''),
    );
  }

  // Verdict.
  const revokeBuckets = sorted.filter(([, b]) => b.revokeGrayTip > 0);
  const contaminated = revokeBuckets.filter(([, b]) => b.otherGrayTip + b.nonGrayTip > 0);
  console.log('\n=== verdict ===');
  console.log(`revoke lives in ${revokeBuckets.length} scalar bucket(s): ${revokeBuckets.map((x) => x[0]).join(', ')}`);
  if (contaminated.length === 0 && revokeBuckets.length > 0) {
    console.log('✅ (40011,40012) ALONE cleanly identifies revoke — no blob parse needed in trigger.');
  } else {
    console.log('⚠️  those buckets ALSO contain non-revoke messages:');
    for (const [key, b] of contaminated) {
      console.log(`   ${key}: revoke=${b.revokeGrayTip} otherGT=${b.otherGrayTip} normal=${b.nonGrayTip}`);
    }
    console.log('   → scalar columns are NOT sufficient; trigger must inspect 40800.');
  }

  db.close();
}

main().catch((e) => {
  console.error('[probe] failed:', e);
  process.exit(1);
});
