/**
 * Dry-run of the renderer's gap rule against real conversations: replay what
 * chatPane will do to a `listLatest` window and report the holes it would draw,
 * so we can sanity-check the counts before trusting the UI.
 *
 * Mirrors `messageGap.tsx`: compare adjacent rows' 40003, treat a jump > 1 as
 * that many missing messages, skip seq-less (phone-imported) rows.
 *
 * Run: pnpm tsx ./packages/db/test/verify_msg_gaps.ts [groupCode] [window]
 */
import { loadNative } from '@weq/native';
import { GroupMsgDb } from '../src/msg/group';
import type { GroupMsg } from '../src/msg/types';
import { testEnv } from '@weq/testkit';

/** Groups with known large holes, plus the reference group. */
const DEFAULT_GROUPS = ['991352210', '932791232', '673646675'];
const WINDOW = Number(process.argv[3] ?? 200);

function ts(v: bigint): string {
  const n = Number(v);
  return n ? new Date(n * 1000).toISOString().replace('T', ' ').slice(0, 19) : '(0)';
}

/** The renderer's rule, verbatim. */
function gapCount(prev: GroupMsg | undefined, cur: GroupMsg): number {
  if (!prev) return 0;
  if (prev.msgSeq <= 0n || cur.msgSeq <= 0n) return 0;
  const missing = cur.msgSeq - prev.msgSeq - 1n;
  // >1, not >0: a single missing seq is almost always one unsynced system
  // notice (the "file received" tip and friends), not a real lost message.
  return missing > 1n ? Number(missing) : 0;
}

async function main(): Promise<void> {
  const groups = process.argv[2] ? [process.argv[2]] : DEFAULT_GROUPS;
  const native = loadNative();
  const db = new GroupMsgDb(native.ntHelper, {
    dbPath: testEnv.msgDbPath,
    key: testEnv.key,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });
  try {
    for (const group of groups) {
      const rendered = (await db.listLatest(group, WINDOW)).reverse();
      console.log(
        `\n${'='.repeat(80)}\n## 群 ${group} — 最近 ${rendered.length} 条里会画出的空洞\n${'='.repeat(80)}`,
      );
      let holes = 0;
      let missing = 0;
      for (let i = 0; i < rendered.length; i++) {
        const cur = rendered[i]!;
        const n = gapCount(rendered[i - 1], cur);
        if (n === 0) continue;
        holes++;
        missing += n;
        const prev = rendered[i - 1]!;
        console.log(
          `   ⌇ 缺 ${String(n).padStart(5)} 条  在 seq ${prev.msgSeq}(${ts(prev.sendTime)}) 与 seq ${cur.msgSeq}(${ts(cur.sendTime)}) 之间`,
        );
      }
      console.log(`   → 共 ${holes} 处空洞, 合计缺 ${missing} 条`);
      if (holes === 0) console.log(`   （这一窗内 seq 完全连续，不会画任何提示）`);
    }
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
