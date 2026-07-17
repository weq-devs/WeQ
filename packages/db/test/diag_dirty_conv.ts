/**
 * 只读：查“kind=group 但 id=u_”的脏会话，消息实际落在哪张表？
 * 决定这些会话该归 c2c(40021) 还是纯噪声丢弃。全 SELECT，不写库。
 * Run: pnpm tsx packages/db/test/diag_dirty_conv.ts
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const LIVE =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;

const DIRTY = [
  'u_DRENktQ9gS_Z02WOT6qugQ', 'u_ycOFKhEd7_qtOjfWv-UZLw', 'u_wRUspIAtivgCxdpsLcnncA',
  'u_BWXVW5J_SZLAAhDvYQNfOg', 'u__MGY1qeieb7HW1HHgOB_Jw', 'u_BKf1vcdbSd7D3fqZkxhz8A',
  'u_BGH9EWoEqk0pTyhoSL4pOA', 'u_lJ6C56tcH3K-DpMrT8qXyQ', 'u_lSj-RIi7KeiH9CYTfy2CoA',
  'u_iSZdS1NOkl1djAoUqBTFJA', 'u_2ZUGgVyaN872ydWFvW1w0A', 'u_oimpHvHOQn8C75nDk6Lu1Q',
  'u_n3yLCyX63Xes2rEZxuL-Bw', 'u_VF3wYKwSfQTsW8K6ePkX6g',
];

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, { dbPath: LIVE, key: KEY, algo: ALGO });

  console.log('id'.padEnd(26) + 'c2c(40021)'.padEnd(12) + 'group(40021)'.padEnd(14) + 'dataline(40021)');
  console.log('-'.repeat(66));
  for (const id of DIRTY) {
    const c = await db.query(`SELECT COUNT(*) FROM c2c_msg_table WHERE "40021"=?`, [id]);
    const g = await db.query(`SELECT COUNT(*) FROM group_msg_table WHERE "40021"=?`, [id]);
    let d = [[0]] as unknown[][];
    try { d = await db.query(`SELECT COUNT(*) FROM dataline_msg_table WHERE "40021"=?`, [id]); } catch { /* no table */ }
    console.log(id.padEnd(26) + String(c[0]![0]).padEnd(12) + String(g[0]![0]).padEnd(14) + String(d[0]![0]));
  }

  console.log('\n=== 判读 ===');
  console.log('  · 若消息都在 c2c(40021) → 前端应把它们归 c2c（用 40021 过滤），改 kindOf 即可保护。');
  console.log('  · 若三表都是 0 → 纯噪声会话，直接从配置剔除。');
  db.close();
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
