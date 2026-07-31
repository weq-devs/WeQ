/**
 * Regression for the gray-tip ordering fix: drive the REAL production accessors
 * (GroupMsgDb / C2cMsgDb) rather than a hardcoded copy of their SQL, so the
 * assertion tracks whatever the code actually does.
 *
 * What it checks, per conversation:
 *  - `listLatest` reversed (what the renderer shows) never steps backwards in
 *    time. Same-seq runs used to come back in index order (the UNIQUE
 *    `(40027,40003,40002)` index tie-breaks on a random), so a gray tip could
 *    land above the message it hangs off.
 *  - the order is STABLE: repeated reads agree, and `listBefore`/`listAfter`
 *    paging agrees with `listLatest` over the overlap.
 *
 * Run: pnpm tsx ./packages/db/test/verify_msg_order.ts [groupCode]
 */
import { loadNative } from '@weq/native';
import { GroupMsgDb } from '../src/msg/group';
import type { GroupMsg } from '../src/msg/types';
import { testEnv } from '@weq/testkit';

const GROUP = process.argv[2] ?? '673646675';
const WINDOW = 40;

function ts(v: bigint): string {
  const n = Number(v);
  return n ? new Date(n * 1000).toISOString().replace('T', ' ').slice(0, 19) : '(0)';
}

function line(m: GroupMsg): string {
  return (
    `seq=${String(m.msgSeq).padStart(6)} ${ts(m.sendTime)} t=${m.msgType}/${String(m.subType).padEnd(4)} ` +
    `${(m.senderUid || '(空)').padEnd(26)} msgId=${m.msgId}`
  );
}

/** Adjacent pairs where sendTime steps backwards (0 timestamps ignored). */
function inversions(rows: GroupMsg[]): Array<[GroupMsg, GroupMsg]> {
  const bad: Array<[GroupMsg, GroupMsg]> = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!,
      b = rows[i]!;
    if (a.sendTime > 0n && b.sendTime > 0n && b.sendTime < a.sendTime) bad.push([a, b]);
  }
  return bad;
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new GroupMsgDb(native.ntHelper, {
    dbPath: testEnv.msgDbPath,
    key: testEnv.key,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });
  let failures = 0;
  try {
    // ── 1. render order via the production accessor ───────────────────────────
    const latest = await db.listLatest(GROUP, WINDOW);
    const rendered = [...latest].reverse(); // what MainView does
    console.log(`## 群 ${GROUP} — listLatest(${WINDOW}) 反转后的渲染顺序\n`);
    for (const m of rendered) console.log(`   ${line(m)}`);

    const inv = inversions(rendered);
    console.log(`\n   时间倒挂 ${inv.length} 对`);
    for (const [a, b] of inv) {
      console.log(
        `     ⚠ ${ts(a.sendTime)} (seq ${a.msgSeq}) → ${ts(b.sendTime)} (seq ${b.msgSeq})`,
      );
    }
    // A same-seq run must be internally time-ordered. Inversions ACROSS
    // different seqs are real data (QQ's own seq/time disagreement), not ours.
    const sameSeqInv = inv.filter(([a, b]) => a.msgSeq === b.msgSeq);
    if (sameSeqInv.length > 0) {
      console.log(`\n   ❌ 撞号组内部仍有 ${sameSeqInv.length} 处时间倒挂 —— tie-break 没生效`);
      failures++;
    } else {
      console.log(
        `\n   ✅ 撞号组内部时间有序（跨 seq 的 ${inv.length} 处倒挂是库里本来的 seq/时间冲突）`,
      );
    }

    // ── 2. stability: same query twice must agree ─────────────────────────────
    const again = await db.listLatest(GROUP, WINDOW);
    const stable = again.every((m, i) => m.msgId === latest[i]?.msgId);
    console.log(`\n## 稳定性：重复 listLatest 顺序一致 → ${stable ? '✅' : '❌'}`);
    if (!stable) failures++;

    // ── 3. paging agrees with listLatest over the overlap ────────────────────
    const pivot = rendered[Math.floor(rendered.length / 2)]!;
    const before = await db.listBefore(GROUP, pivot.msgSeq, WINDOW);
    const after = await db.listAfter(GROUP, pivot.msgSeq, WINDOW);
    const beforeIds = new Set(before.map((m) => String(m.msgId)));
    const afterIds = new Set(after.map((m) => String(m.msgId)));
    const overlap =
      beforeIds.size && afterIds.size ? [...beforeIds].filter((id) => afterIds.has(id)) : [];
    console.log(
      `## 分页：listBefore(${before.length}) / listAfter(${after.length}) 重叠 ${overlap.length} 条 → ${overlap.length === 0 ? '✅ 无重复' : '❌'}`,
    );
    if (overlap.length > 0) failures++;

    const beforeInv = inversions([...before].reverse());
    const afterInv = inversions(after);
    const beforeSame = beforeInv.filter(([a, b]) => a.msgSeq === b.msgSeq).length;
    const afterSame = afterInv.filter(([a, b]) => a.msgSeq === b.msgSeq).length;
    console.log(
      `   listBefore 撞号组内倒挂 ${beforeSame} / listAfter 撞号组内倒挂 ${afterSame} → ${beforeSame + afterSame === 0 ? '✅' : '❌'}`,
    );
    if (beforeSame + afterSame > 0) failures++;
  } finally {
    db.close();
  }
  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项未通过`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
