/**
 * 真机验证收尾：用**正式的 AntiRecallDb**（非复刻）给单个测试群装 trigger，
 * 然后你在 QQ 里真实撤回一条该群消息，跑 verify 看效果，最后 cleanup 还原。
 *
 * 与 e2e 脚本的区别：这里走真实代码路径（AntiRecallDb.reconcile），且撤回是 QQ
 * 进程真实产生的（不是手动模拟），能验证：
 *   - 真实撤回灰条里 revoke_uid 的 SQL 提取（假 blob 测不到）
 *   - QQ 真实写入被拦、原文保住
 *   - 补插灰条在 QQ 界面里的真实渲染
 *
 * ⚠️ 只保护 TEST_GROUP 一个群，不动你真实的 anti-recall 配置文件（本脚本不经过
 *    AntiRecallService，直接用 AntiRecallDb，配置文件无关）。
 *
 * 用法（TEST_GROUP 默认 673646675）：
 *   1. 关 QQ
 *   pnpm tsx packages/db/test/verify_real_recall.ts install [群号]
 *   2. 开 QQ → 在该群发一条消息 → 撤回它
 *   3. 关 QQ
 *   pnpm tsx packages/db/test/verify_real_recall.ts verify [群号]
 *   4. pnpm tsx packages/db/test/verify_real_recall.ts cleanup [群号]   # 删 trigger+记录表+补插灰条
 */
import { loadNative } from '@weq/native';
import { AntiRecallDb } from '../src/msg/anti_recall';
import { QqDb } from '../src/qq_db';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;

const CMD = process.argv[2] ?? 'verify';
const GROUP = process.argv[3] ?? '673646675';
const _json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

function assertClosed(nt: ReturnType<typeof loadNative>): void {
  if (nt.ntHelper.getQqProcesses().length) { console.error('先关 QQ（install/cleanup 需要写锁）'); process.exit(1); }
}

async function main(): Promise<void> {
  const nt = loadNative();

  if (CMD === 'install') {
    assertClosed(nt);
    const ar = new AntiRecallDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
    await ar.reconcile([{ kind: 'group', id: GROUP }]);
    console.log(`✅ 已用正式 AntiRecallDb 给群 ${GROUP} 装 trigger + 建记录表。`);
    console.log('   现在：开 QQ → 在该群发消息 → 撤回 → 关 QQ → 跑 verify。');
    ar.close();
    return;
  }

  if (CMD === 'verify') {
    const db = new QqDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
    // 记录表（方案C：trigger 只记录，msgid 是 PK，按 recall_ts 排）
    const log = await db.query(
      `SELECT msgid,conv,table_kind,sender_uid,revoke_uid,orig_seq,recall_ts,length(orig_body),graytip_done
         FROM weq_recall_log ORDER BY recall_ts DESC LIMIT 5`,
    ).catch((e) => { console.log('  (读记录表失败:', e instanceof Error ? e.message : e, ')'); return []; });
    console.log(`=== weq_recall_log 最近 ${log.length} 条 ===`);
    for (const r of log) {
      const same = String(r[3]) === String(r[4]);
      console.log(`  msg=${r[0]} conv=${r[1]}/${r[2]} sender=${r[3]} revoke=${r[4]} ${r[4] ? (same ? '(本人撤回)' : '(⚠️他人/管理员撤回)') : '(未提取到)'} seq=${r[5]} ts=${r[6]} bodyLen=${r[7]} graytip_done=${r[8]}`);
    }
    // 被撤原消息是否还在（方案C：拦截成功=原文2/x保住；灰条由JS补插，这里不验灰条）
    if (log.length) {
      console.log(`\n=== 各被撤消息现状（拦截是否成功）===`);
      for (const r of log) {
        const origId = r[0] as bigint;
        const orig = await db.query(`SELECT "40011","40012",length("40800") FROM group_msg_table WHERE "40001"=?`, [origId]).catch(() => []);
        if (orig.length) {
          const kept = String(orig[0]![0]) === '2';
          console.log(`  msg=${origId}  现 ${orig[0]![0]}/${orig[0]![1]} bodyLen=${orig[0]![2]}  ${kept?'✅ 原文保住(拦截成功)':'⚠️ 变5/4(没拦住)'}`);
        }
      }
      console.log(`\n=== 判读 ===`);
      console.log(`  记录表≥1 + 原文保住 + graytip_done=0 → 方案C正式路径成立，待 JS 补插灰条。`);
    } else {
      console.log('\n（记录表为空——没撤回，或撤的会话不在保护列表，或记录被废）');
    }
    db.close();
    return;
  }

  if (CMD === 'cleanup') {
    assertClosed(nt);
    const db = new QqDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
    const ar = new AntiRecallDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
    await ar.reconcile([]); // 卸所有 anti-recall trigger
    await db.write(`DROP TABLE IF EXISTS weq_recall_log`);
    console.log(`✅ 已卸 trigger、删记录表。`);
    ar.close(); db.close();
    return;
  }

  console.error('用法: install | verify | cleanup  [群号]');
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
