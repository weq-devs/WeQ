/**
 * 决定性测试：BEFORE UPDATE 触发器里，`OLD.col IN ('字符串字面量')` 能否命中
 * 一个 INTEGER 存储的列？（对比 c2c 的 TEXT 列 vs group 的 INTEGER 列）
 *
 * 之前只测了 SELECT 的 WHERE，两种都命中 → 误判"无区别"。但触发器 WHEN 里 OLD.col
 * 取的是列的**存储值**，与字符串字面量比较时的类型亲和规则未必和普通 WHERE 相同。
 * 私聊(TEXT)成功、群聊(INTEGER)失败的强相关，必须实测触发器语义本身。
 *
 * 做法：在一个**临时的、我们自己的**内存/磁盘 sqlite 上复现，不碰 QQ 库。
 * 建两列（一 INTEGER 一 TEXT），各装 IN('123') 与 IN(123) 触发器，UPDATE 看谁 fire。
 *
 * Run: pnpm tsx packages/db/test/diag_trigger_typeaffinity.ts
 */
import { loadNative } from '@weq/native';

// 用 QQ 的 native sqlite，但开一个全新的临时明文库（无 key），只做逻辑验证。
import { QqDb } from '../src/qq_db';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

async function main(): Promise<void> {
  const nt = loadNative();
  const path = join(tmpdir(), `weq_trig_test_${Date.now()}.db`);
  const db = new QqDb(nt.ntHelper, { dbPath: path }); // 明文，无 key

  try {
    // t 列 INTEGER（模拟 40027 群号），x 列 TEXT（模拟 40021 uid）
    await db.write(`CREATE TABLE m (id INTEGER PRIMARY KEY, gcode INTEGER, uid TEXT, body TEXT, blocked INTEGER DEFAULT 0)`);
    await db.write(`INSERT INTO m (id,gcode,uid,body) VALUES (1, 673646675, 'u_abc', 'orig')`);

    // 审计触发器：如果 fire，就把 blocked 置 1（这里不 RAISE，改用 side effect 观察）
    // 分别测 4 种组合。每种用独立触发器名。
    const cases: Array<{ name: string; when: string; desc: string }> = [
      { name: 't_int_num', when: `OLD.gcode IN (673646675)`, desc: 'INTEGER列 vs 数字字面量' },
      { name: 't_int_str', when: `OLD.gcode IN ('673646675')`, desc: 'INTEGER列 vs 字符串字面量' },
      { name: 't_txt_num', when: `OLD.uid IN (673646675)`, desc: 'TEXT列 vs 数字字面量（对照）' },
      { name: 't_txt_str', when: `OLD.uid IN ('u_abc')`, desc: 'TEXT列 vs 字符串字面量' },
    ];

    for (const c of cases) {
      // 每种情况：重置 blocked → 装触发器 → UPDATE body → 看 blocked 是否被置1 → 删触发器
      await db.write(`UPDATE m SET blocked=0 WHERE id=1`);
      await db.write(
        `CREATE TRIGGER ${c.name} BEFORE UPDATE OF body ON m WHEN ${c.when}
         BEGIN UPDATE m SET blocked=1 WHERE id=NEW.id; END`,
      );
      await db.write(`UPDATE m SET body='changed' WHERE id=1`);
      const r = await db.query(`SELECT blocked FROM m WHERE id=1`);
      const fired = Number(r[0]![0]) === 1;
      console.log(`  [${fired ? 'FIRE ✅' : 'miss ❌'}] ${c.desc.padEnd(30)} WHEN ${c.when}`);
      await db.write(`DROP TRIGGER ${c.name}`);
      await db.write(`UPDATE m SET body='orig' WHERE id=1`);
    }

    console.log('\n=== 判读 ===');
    console.log('  关注 [INTEGER列 vs 字符串字面量]：');
    console.log('   · 若 miss ❌ → 找到根因！群触发器 IN(\'123\') 匹配不上 INTEGER 的 40027，必须去掉引号。');
    console.log('   · 若 FIRE ✅ → 类型亲和在触发器里也生效，字符串比较无区别，根因在别处（如连接未重载）。');
  } finally {
    db.close();
    try { rmSync(path, { force: true }); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
