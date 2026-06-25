/**
 * Real-data efficiency test for the media scanner.
 *
 * Scans a whole (large) group's referenced media against the local disk and
 * reports how many are present vs missing, plus a timing breakdown
 * (DB collect / index build / match). The point is to see whether the
 * index-once approach stays fast on real data.
 *
 * Run:  pnpm --filter @weq/service test:scan-media
 */

import { resolve } from 'node:path';
import { loadNative } from '@weq/native';
import { GroupMsgDb } from '@weq/db';
import { MsgService } from '../src/account/msg';
import { scanConvMedia, mediaDirsFromAccountDir, type MediaKind } from '../src/account/export';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const GROUP_CODE = '932791232';
const DB_PATH = String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;

const KINDS: MediaKind[] = ['pic', 'video', 'ptt', 'emoji', 'file'];

async function main(): Promise<void> {
  const native = loadNative();
  const groupMsgsDb = new GroupMsgDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });
  const session = { groupMsgs: groupMsgsDb, lastRowIdMaps: { groupRowId: 0n } } as any;
  const msgs = new MsgService(session);

  // accountDir = …/<uin>, three levels up from nt_qq/nt_db/nt_msg.db.
  const accountDir = resolve(DB_PATH, '..', '..', '..');
  const dirs = mediaDirsFromAccountDir(accountDir);

  console.log(`[test:scan-media] group ${GROUP_CODE}`);
  console.log(`[test:scan-media] media root ${accountDir}\\nt_qq\\nt_data\n`);

  try {
    const r = await scanConvMedia(msgs, 'group', GROUP_CODE, dirs, { pageSize: 2000 });

    console.log('  per-kind  (unique / found / missing / expired / downloadable):');
    for (const kind of KINDS) {
      const c = r.byKind[kind];
      if (c.refs === 0) continue;
      console.log(
        `    ${kind.padEnd(6)} ${String(c.unique).padStart(6)} / ${String(c.found).padStart(6)} / ` +
          `${String(c.missing).padStart(6)} / ${String(c.expired).padStart(6)} / ${String(c.downloadable).padStart(6)}`,
      );
    }

    const shrink = r.missingFiles ? Math.round((r.expiredFiles / r.missingFiles) * 100) : 0;
    console.log('\n  totals:');
    console.log(`    references     : ${r.totalRefs}`);
    console.log(`    unique         : ${r.uniqueFiles}`);
    console.log(`    found on disk  : ${r.foundFiles}`);
    console.log(`    missing        : ${r.missingFiles}`);
    console.log(`    ├─ expired     : ${r.expiredFiles}   (TTL 已过期，无法下载)`);
    console.log(`    └─ downloadable: ${r.downloadableFiles}   (实际下载清单)`);
    console.log(`    → 清单缩水      : ${r.missingFiles} → ${r.downloadableFiles}  (-${shrink}%)`);

    // TTL formula sanity-check: uploadTimestamp should sit near sendTime, and
    // expiresAt = uploadTimestamp + fileTTL should look sane.
    console.log('\n  TTL samples (pic, first 6 missing):');
    const picSamples = r.missing.filter((m) => m.kind === 'pic').slice(0, 6);
    for (const m of picSamples) {
      const dExpiry = m.expiresAt ? new Date(m.expiresAt * 1000).toISOString().slice(0, 10) : '—';
      const skew = m.uploadTimestamp ? m.uploadTimestamp - m.sendTime : NaN;
      console.log(
        `    send=${m.sendTime} upTs=${m.uploadTimestamp} (Δsend=${skew}) ` +
          `ttl=${m.fileTTL} → expire=${dExpiry} ${m.expired ? 'EXPIRED' : 'ok'}`,
      );
    }

    console.log('\n  timing:');
    console.log(`    db collect : ${r.collectMs} ms`);
    console.log(`    index build: ${r.indexBuildMs} ms  (${r.indexedDirs} dirs, ${r.indexedFiles} files indexed)`);
    console.log(`    match      : ${r.matchMs} ms`);
    console.log(`    total      : ${r.durationMs} ms`);

    // ---- assertions ----
    if (r.totalRefs <= 0) throw new Error('no media references found — unexpected for this group');
    if (r.foundFiles + r.missingFiles !== r.uniqueFiles) throw new Error('found + missing != unique');
    if (r.expiredFiles + r.downloadableFiles !== r.missingFiles) throw new Error('expired + downloadable != missing');

    console.log('\n[test:scan-media] PASS');
  } finally {
    groupMsgsDb.close();
  }
}

main().catch((e) => {
  console.error('[test:scan-media] failed:', e);
  process.exit(1);
});
