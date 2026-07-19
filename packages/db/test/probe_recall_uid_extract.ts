/**
 * 为"trigger 里从 NEW.40800(撤回灰条) 用 SQL 提取撤回者 uid"探路。
 * 撤回者 uid = field 47704 (recallRevokeUid)，wire tag = (47704<<3)|2。
 *   47704<<3|2 = 381634 -> varint: c2 a5 17  →  tag 字节 'c2a517'
 * uid 恒 24B，所以定位到 tag 后：跳过 3B tag + 1B len(0x18) + 取 24B = uid。
 *
 * 本脚本在真库撤回灰条上验证：instr(40800, X'c2a517') 能否稳定定位，substr 切出的
 * 24B 是否正好是 u_ 开头 ascii。全只读。
 *
 * Run: pnpm tsx packages/db/test/probe_recall_uid_extract.ts [table] [n]
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv } from '@weq/testkit';

const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB = testEnv.msgDbPath;
const TABLE = process.argv[2] ?? 'group_msg_table';
const N = Number(process.argv[3] ?? 5);

async function main(): Promise<void> {
  const nt = loadNative();
  const db = new QqDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });

  // 用纯 SQL 提取：定位 tag c2a517(revokeUid) 与 baa517(senderUid)，各切 24B
  const rows = await db.query(
    `SELECT "40001",
            "40020" AS old_sender,
            "40093" AS old_nick,
            hex(substr("40800", instr("40800", X'c2a517') + 4, 24)) AS revoke_uid_hex,
            hex(substr("40800", instr("40800", X'baa517') + 4, 24)) AS sender_uid_hex,
            instr("40800", X'c2a517') AS pos_revoke,
            instr("40800", X'baa517') AS pos_sender
       FROM ${TABLE}
      WHERE "40011"=5 AND "40012"=4 AND "40800" IS NOT NULL
      ORDER BY rowid DESC LIMIT ?`,
    [BigInt(N)],
  );

  const fromHex = (h: unknown): string => {
    if (typeof h !== 'string' || !h) return '(空)';
    try { return Buffer.from(h, 'hex').toString('utf8'); } catch { return '(非utf8)'; }
  };

  console.log(`${TABLE}: ${rows.length} 条撤回灰条，SQL 提取 uid 验证\n`);
  for (const r of rows) {
    console.log(`msg ${r[0]}`);
    console.log(`  原发送者(OLD.40020) = ${r[1]}   原昵称(OLD.40093) = ${r[2]}`);
    console.log(`  tag位置: revoke=${r[5]} sender=${r[6]}`);
    console.log(`  提取 revokeUid = "${fromHex(r[3])}"  ${String(fromHex(r[3])).startsWith('u_') ? '✅' : '❌'}`);
    console.log(`  提取 senderUid = "${fromHex(r[4])}"  ${String(fromHex(r[4])).startsWith('u_') ? '✅' : '❌'}`);
    console.log('');
  }

  console.log('=== 判读 ===');
  console.log('  · 若 revokeUid/senderUid 都稳定切出 u_ 开头 24B → SQL 可在 trigger 里提取撤回者，记录表能存"谁撤的"。');
  console.log('  · revokeUid==senderUid → 本人撤回；不等 → 管理员撤他人(正是你要区分的场景)。');

  db.close();
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
