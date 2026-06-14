/**
 * Integration test for `ForwardMsgDb` — the 40900 forward/reply cache.
 *
 * Two c2c msgIds (dev account):
 *   7650613959134651362  — simple
 *   7650606983844292501  — hard (nested 40900)
 *
 * Run:  pnpm --filter @weq/db test:forward
 */

import { loadNative } from '@weq/native';
import { ForwardMsgDb } from '../src/msg/forward';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

const MSG_IDS: bigint[] = [7650613959134651362n, 7650606983844292501n];

async function main(): Promise<void> {
  const native = loadNative();
  const db = new ForwardMsgDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  for (const id of MSG_IDS) {
    console.log(`\n===== c2c msgId ${id} =====`);
    const records = await db.listC2cForward(id);
    console.log(`top-level 40900 records: ${records.length}`);
    console.log(JSON.stringify(records, replacer, 2));
  }

  db.close();
}

function replacer(_k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return `<bytes ${v.length}>`;
  // Node Buffer serializes via toJSON() before reaching the replacer, arriving
  // as { type: 'Buffer', data: number[] } — collapse that to a length marker.
  if (
    v !== null &&
    typeof v === 'object' &&
    (v as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((v as { data?: unknown }).data)
  ) {
    return `<bytes ${(v as { data: unknown[] }).data.length}>`;
  }
  return v;
}

main().catch((e) => {
  console.error('[test:forward] failed:', e);
  process.exit(1);
});
