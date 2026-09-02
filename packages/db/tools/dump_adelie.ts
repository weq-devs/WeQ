/** profile_info_adelie（机器人 profile）全表 dump。 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv } from '@weq/testkit';
import { raw } from '@weq/codec';

function describe(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof Uint8Array) return `<BLOB ${v.byteLength}b>`;
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'string') return v.length > 400 ? `"${v.slice(0, 400)}…"` : `"${v}"`;
  return String(v);
}

async function main() {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: testEnv.profileDbPath,
    key: testEnv.key,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });
  const tables = await db.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%adelie%'`,
  );
  console.log(
    'tables:',
    tables.map((t) => String(t[0])),
  );
  for (const t of tables) {
    const table = String(t[0]);
    const info = await db.query(`PRAGMA table_info("${table}")`);
    const cols = info.map((r) => String(r[1]));
    console.log(`\n=== ${table} cols: ${cols.join(',')} ===`);
    const rows = await db.query(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM "${table}"`);
    console.log(`rows: ${rows.length}`);
    for (const row of rows) {
      console.log('\n--- row ---');
      for (let i = 0; i < cols.length; i++) {
        const v = row[i];
        if (v === null || v === undefined || v === '' || v === 0n) continue;
        console.log(`  ${cols[i]!.padEnd(8)} = ${describe(v)}`);
        if (v instanceof Uint8Array && v.byteLength) {
          try {
            console.log(`    hex: ${Buffer.from(v).toString('hex').slice(0, 400)}`);
            console.log(
              `    raw: ${JSON.stringify(raw.decode(v), (_k, x) => (typeof x === 'bigint' ? x.toString() : x))}`.slice(
                0,
                3000,
              ),
            );
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  db.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
