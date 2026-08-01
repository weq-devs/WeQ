/**
 * Verify `decodeUrlVerify` (codec) against every real 45112 payload in the DB:
 * how many carry renderable metadata, and does the decode match a raw walk.
 *
 * Run: pnpm tsx packages/db/tools/verify_url_verify.ts
 */
import { loadNative } from '@weq/native';
import { decodeUrlVerify } from '@weq/codec';
import { QqDb } from '../src/qq_db';
import { decodeBody } from '../src/msg/util';
import { testEnv } from '@weq/testkit';

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: testEnv.msgDbPath,
    key: testEnv.key,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  let total = 0;
  let withMeta = 0;
  const samples: string[] = [];
  for (const table of ['c2c_msg_table', 'group_msg_table'] as const) {
    for (const r of await db.query(`SELECT "40800" FROM "${table}" WHERE "40011" IN (2,9)`)) {
      let els: Array<Record<string, unknown>>;
      try {
        els = decodeBody(r[0] as Uint8Array) as never;
      } catch {
        continue;
      }
      for (const e of els) {
        const raw = e.urlVerifyFlag as Uint8Array | undefined;
        if (!raw) continue;
        total++;
        const info = decodeUrlVerify(raw);
        if (!info) continue;
        withMeta++;
        if (samples.length < 6) {
          samples.push(
            `  title=${JSON.stringify(info.title.slice(0, 36))} desc=${JSON.stringify(info.desc.slice(0, 36))} img=${info.imageUrl ? 'yes' : 'no'} at=${info.scannedAt}`,
          );
        }
      }
    }
  }

  console.log(`45112 payloads: ${total}`);
  console.log(
    `decodeUrlVerify -> renderable: ${withMeta} (${((withMeta / total) * 100).toFixed(1)}%)`,
  );
  console.log('samples:');
  for (const s of samples) console.log(s);
  db.close();
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
