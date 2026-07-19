/**
 * Real-data test for merged-forward (合并转发) expansion in the export pipeline.
 *
 * Verifies the fix for "导出时合并转发只导出一个卡片，丢失里面的内容": the exporters
 * now read the 40900 cache, lift it into `ForwardMessage[]`, and render the real
 * forwarded content instead of a bare `[合并转发]` placeholder.
 *
 * Uses the same two c2c msgIds as `@weq/db`'s test/forward.ts:
 *   7650613959134651362 — simple forward
 *   7650606983844292501 — nested forward (40900 inside 40900)
 *
 * Run:  pnpm --filter @weq/service test:forward-expand
 */

import { loadNative } from '@weq/native';
import { ForwardMsgDb } from '@weq/db';
import { liftForwardRecords } from '../src/account/export/forward_expand';
import { forwardToText } from '../src/account/export/element_text';
import type { ForwardMessage } from '../src/account/msg_view';
import { testEnv } from '@weq/testkit';

const DB_PATH = testEnv.msgDbPath;
const KEY = testEnv.key;

const MSG_IDS: bigint[] = [7650613959134651362n, 7650606983844292501n];

function fail(msg: string): never {
  throw new Error(msg);
}

/** Count messages at every depth (a nested forward contributes its own subtree). */
function countDeep(messages: ForwardMessage[]): number {
  let n = messages.length;
  for (const msg of messages) {
    for (const el of msg.elements) {
      if (el.type === 'multiMsg' && el.data.forwardMessages) {
        n += countDeep(el.data.forwardMessages);
      }
    }
  }
  return n;
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new ForwardMsgDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  try {
    for (const id of MSG_IDS) {
      console.log(`\n===== c2c msgId ${id} =====`);
      const records = await db.listC2cForward(id);
      const lifted = liftForwardRecords(records);
      const total = countDeep(lifted);
      console.log(`top-level messages: ${lifted.length} · total (incl. nested): ${total}`);

      if (lifted.length === 0) fail(`msgId ${id}: no forwarded messages lifted`);

      // Every lifted message must carry a resolved sender name.
      for (const msg of lifted) {
        if (!msg.senderName) fail(`msgId ${id}: a forwarded message has no senderName`);
      }

      // The text renderer must produce the [合并转发] header + at least one
      // "名字: 内容" line (not the bare placeholder alone).
      const text = forwardToText(lifted, 1);
      if (!text.startsWith('[合并转发]')) fail(`msgId ${id}: text missing 合并转发 header`);
      if (!text.includes('\n')) fail(`msgId ${id}: text has no expanded lines (still a bare placeholder)`);

      console.log('  rendered text preview:');
      for (const line of text.split('\n').slice(0, 8)) console.log(`    ${line.slice(0, 90)}`);
    }

    console.log('\n[test:forward-expand] PASS');
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error('[test:forward-expand] failed:', e);
  process.exit(1);
});
