/**
 * 实测 profile_info_v6：陌生人（非好友）到底存了哪些字段。
 *
 * Run:  pnpm tsx ./packages/db/test/dump_profile_info.ts
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const UIN_ME = '1707889225';
const DB_PATH =
  process.env.WEQ_TEST_PROFILE_DB_PATH ??
  `D:\\estkim\\T\\Tencent Files\\${UIN_ME}\\nt_qq\\nt_db\\profile_info.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

const TABLE = 'profile_info_v6';

function log(msg: string): void {
  console.error(msg); // stderr：无缓冲，卡住也能看到进度
}

function describe(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v).toString('hex');
    return `<BLOB ${v.byteLength}b> ${hex.length > 120 ? hex.slice(0, 120) + '…' : hex}`;
  }
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'string') return v.length > 160 ? `"${v.slice(0, 160)}…"` : `"${v}"`;
  return `${String(v)}`;
}

async function dumpRow(db: QqDb, cols: string[], where: string): Promise<void> {
  const rows = await db.query(`SELECT * FROM "${TABLE}" WHERE ${where} LIMIT 1`);
  const row = rows[0];
  if (!row) {
    log(`  (no row for ${where})`);
    return;
  }
  for (let i = 0; i < cols.length; i++) {
    log(`  ${(cols[i] ?? `#${i}`).padEnd(8)} = ${describe(row[i])}`);
  }
}

async function main(): Promise<void> {
  log('[1] loadNative…');
  const native = loadNative();
  log('[2] open db…');
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  log('[3] PRAGMA table_info…');
  const info = await db.query(`PRAGMA table_info("${TABLE}")`);
  log(`\n== ${TABLE} columns (${info.length}) ==`);
  for (const row of info) {
    log(`  ${String(row[1]).padEnd(8)} ${String(row[2] || '').padEnd(10)} pk=${row[5]}`);
  }
  const cols = info.map((r) => String(r[1]));

  log('[4] counts…');
  const total = (await db.query(`SELECT COUNT(*) FROM "${TABLE}"`))[0]?.[0];
  const withRel = (await db.query(`SELECT COUNT(*) FROM "${TABLE}" WHERE "20072" IS NOT NULL`))[0]?.[0];
  const noRel = (await db.query(`SELECT COUNT(*) FROM "${TABLE}" WHERE "20072" IS NULL`))[0]?.[0];
  log(`  总行数=${total}  有密友关系(好友)=${withRel}  无20072(陌生人)=${noRel}`);

  log('[5] 陌生人样本 (20072 IS NULL, 取3行)…');
  const strangers = await db.query(`SELECT "1000" FROM "${TABLE}" WHERE "20072" IS NULL LIMIT 3`);
  if (strangers.length === 0) log('  (没有 20072 为空的行 —— 这表几乎只存好友!)');
  for (const s of strangers) {
    const uid = String(s[0]);
    log(`\n---- 陌生人 uid=${uid} ----`);
    await dumpRow(db, cols, `"1000" = '${uid}'`);
  }

  log('\n[6] 好友样本 (20072 IS NOT NULL)…');
  await dumpRow(db, cols, `"20072" IS NOT NULL`);

  log('[done]');
  db.close();
}

main().catch((e) => {
  console.error('[dump-profile-info] failed:', e);
  process.exit(1);
});
