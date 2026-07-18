/**
 * One-off probe: flip the notify-highlight kind (field 50000) of ONE
 * conversation's unread blob from 1006 (特别关心) → 1001, to see how QQ renders
 * the unknown/other kind. Everything else in the blob is left byte-for-byte
 * identical: we locate the exact `tag(50000) + varint(1006)` byte run and swap
 * only the value varint to 1001 (same 2-byte length → blob length unchanged).
 *
 * Safety:
 *   - Original blob hex is dumped to <this>.bak.txt BEFORE any write.
 *   - WEQ_DRY_RUN=1 → print the plan, write nothing.
 *   - WEQ_RESTORE=1 → write the .bak blob back (undo).
 *
 * ⚠️ Writes to the live nt_msg.db. Best run with QQ closed. The write()
 *    helper always drops the connection afterwards (releases the lock).
 *
 * Run:  pnpm tsx packages/db/test/patch_unread_kind.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { ProtoMsg } from '@weq/codec';
import { UnreadInfo } from '@weq/codec/proto/msg/48902';
import { testEnv } from '@weq/testkit';

const DB_PATH = testEnv.msgDbPath;
const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;

const PEER = process.env.WEQ_PEER ?? '2_673646675';
const OLD_KIND = 1003;
const NEW_KIND = 1005;
const FIELD_50000 = 50000;

const DRY_RUN = testEnv.dryRun;
const RESTORE = testEnv.restore;
const BAK_PATH = fileURLToPath(new URL('./patch_unread_kind.bak.txt', import.meta.url));

function encodeVarint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  out.push(v & 0x7f);
  return out;
}
const toHex = (b: Uint8Array | number[]): string =>
  Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): Uint8Array =>
  new Uint8Array((h.match(/.{2}/g) ?? []).map((x) => parseInt(x, 16)));

/** Indices where `needle` occurs in `hay`. */
function findAll(hay: Uint8Array, needle: number[]): number[] {
  const hits: number[] = [];
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    hits.push(i);
  }
  return hits;
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, { dbPath: DB_PATH, key: KEY, algo: ALGO });
  const proto = new ProtoMsg(UnreadInfo);

  const rows = await db.query(
    `SELECT "48902" FROM msg_unread_info_table WHERE "48901" = ? LIMIT 1`,
    [PEER],
  );
  const orig = rows[0]?.[0];
  if (!(orig instanceof Uint8Array)) throw new Error(`no unread blob for peer ${PEER}`);

  console.log(`[patch] peer=${PEER}  blob=${orig.length} bytes`);
  console.log(`[patch] original hex:\n${toHex(orig)}`);
  console.log(`[patch] original decoded:`, JSON.stringify(proto.decode(orig), (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

  // ── restore mode ──────────────────────────────────────────────────────
  if (RESTORE) {
    const bakHex = readFileSync(BAK_PATH, 'utf8').trim();
    const bak = fromHex(bakHex);
    console.log(`\n[restore] writing back ${bak.length} bytes from ${BAK_PATH}`);
    if (!DRY_RUN) {
      const n = await db.write(`UPDATE msg_unread_info_table SET "48902" = ? WHERE "48901" = ?`, [bak, PEER]);
      console.log(`[restore] rows updated = ${n}`);
    }
    db.close();
    return;
  }

  // ── build & locate the exact byte run: tag(50000) + varint(OLD_KIND) ──
  const tag = encodeVarint(FIELD_50000 * 8); // wiretype 0 (varint)
  const oldRun = [...tag, ...encodeVarint(OLD_KIND)];
  const newRun = [...tag, ...encodeVarint(NEW_KIND)];
  console.log(`\n[patch] tag(50000)=${toHex(tag)}  oldRun=${toHex(oldRun)}  newRun=${toHex(newRun)}`);

  const hits = findAll(orig, oldRun);
  if (hits.length !== 1) {
    throw new Error(`expected exactly 1 occurrence of kind=${OLD_KIND} run, found ${hits.length} — aborting to avoid touching the wrong bytes`);
  }
  const at = hits[0]!;
  console.log(`[patch] found kind=${OLD_KIND} at byte offset ${at}`);

  // Back up original BEFORE writing.
  writeFileSync(BAK_PATH, toHex(orig), 'utf8');
  console.log(`[patch] backed up original → ${BAK_PATH}`);

  // Apply the single-run swap (same length).
  const patched = new Uint8Array(orig);
  patched.set(newRun, at);
  if (patched.length !== orig.length) throw new Error('length changed — aborting');

  // Sanity: decode patched, confirm ONLY the kind changed.
  const before = proto.decode(orig);
  const after = proto.decode(patched);
  console.log(`\n[patch] patched hex:\n${toHex(patched)}`);
  console.log(`[patch] msgSeq  ${before.info?.msgSeq} → ${after.info?.msgSeq}  (must be equal)`);
  console.log(`[patch] kind    ${before.info?.ext?.highlight?.[0]?.kind} → ${after.info?.ext?.highlight?.[0]?.kind}  (want ${OLD_KIND} → ${NEW_KIND})`);

  if (DRY_RUN) {
    console.log(`\n[patch] DRY RUN — nothing written.`);
    db.close();
    return;
  }

  const n = await db.write(`UPDATE msg_unread_info_table SET "48902" = ? WHERE "48901" = ?`, [patched, PEER]);
  console.log(`\n[patch] rows updated = ${n}`);

  // Re-read to confirm it stuck.
  const check = await db.query(`SELECT "48902" FROM msg_unread_info_table WHERE "48901" = ? LIMIT 1`, [PEER]);
  const now = check[0]?.[0] as Uint8Array;
  console.log(`[patch] re-read decoded:`, JSON.stringify(proto.decode(now), (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

  db.close();
  console.log(`\n[patch] done. To undo: WEQ_RESTORE=1 pnpm tsx packages/db/test/patch_unread_kind.ts`);
}

main().catch((e) => {
  console.error('[patch] failed:', e);
  process.exit(1);
});
