import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv, qqDbPath } from '@weq/testkit';
import { ProtoMsg } from '@weq/codec';
import { sanitizeBytes } from '@weq/codec/raw';
import { RecentContactBody } from '@weq/codec/proto/msg/40051';
const native = loadNative();
const db = new QqDb(native.ntHelper, {
  dbPath: qqDbPath('guild_msg.db'),
  key: testEnv.key,
  algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as never,
});
const codec = new ProtoMsg(RecentContactBody);
async function main() {
  try {
    const rows = await db.query(
      `SELECT "40051" FROM direct_node_list_table WHERE "40051" IS NOT NULL LIMIT 1`,
    );
    const blob = rows[0]?.[0] as Uint8Array | undefined;
    if (!(blob instanceof Uint8Array)) return;
    const decoded = codec.decode(sanitizeBytes(blob, RecentContactBody));
    const w = (decoded as { preview?: unknown[] }).preview?.[0] as
      | Record<string, unknown>
      | undefined;
    console.log('wire keys:', w ? Object.keys(w).join(', ') : 'none');
    if (!w) return;
    for (const [k, v] of Object.entries(w)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'string')
        console.log(`  ${k} = str(${v.length}) ${JSON.stringify(v.slice(0, 100))}`);
      else if (typeof v === 'object')
        console.log(
          `  ${k} = ${Array.isArray(v) ? `array[${v.length}]` : 'object'} ${JSON.stringify(v).slice(0, 140)}`,
        );
      else console.log(`  ${k} = ${String(v)}`);
    }
  } finally {
    db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
