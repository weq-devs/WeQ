/**
 * Test — UnifiedSearchService over a real account session.
 *
 * Run:  pnpm --filter @weq/service tools:unified-search -- <keyword>
 *   or: WEQ_TEST_KEYWORD=<kw> pnpm --filter @weq/service tools:unified-search
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openAccount } from '@weq/account';
import { loadNative } from '@weq/native';
import { createWin32Platform } from '@weq/platform';
import { UnifiedSearchService } from '../src/account/unified_search';
import { testEnv } from '@weq/testkit';

const KEYWORD = process.argv.slice(2).find((a) => a !== '--') ?? testEnv.keyword ?? '哈哈';

async function main(): Promise<void> {
  const platform = createWin32Platform(loadNative());
  const session = await openAccount(platform, {
    uin: testEnv.uin,
    dbKey: testEnv.key,
    algos: { 'nt_msg.db': { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } },
  });
  const native = loadNative();
  const search = new UnifiedSearchService(session, {
    dataDir: join(tmpdir(), 'weq-search-index', testEnv.uin),
    nt: native.ntHelper,
  });

  const t0 = performance.now();
  const quick = await search.quickSearch(KEYWORD, 3);
  console.log(
    `[unified-search] keyword="${KEYWORD}" quickSearch took ${(performance.now() - t0).toFixed(0)}ms`,
  );
  console.log('  conversations:', JSON.stringify(quick.conversations, null, 1));
  console.log('  friends:', JSON.stringify(quick.friends, null, 1));
  console.log('  groupMembers:', JSON.stringify(quick.groupMembers, null, 1));

  const t1 = performance.now();
  const slow = await search.slowSearch(KEYWORD, 3);
  console.log(`[unified-search] slowSearch took ${(performance.now() - t1).toFixed(0)}ms`);
  console.log('  chatRecords:', JSON.stringify(slow.chatRecords, null, 1));
  console.log('  files:', JSON.stringify(slow.files, null, 1));

  // chat-record modal: pull a page from the first chatRecord hit, if any
  const top = slow.chatRecords[0];
  if (top) {
    const t2 = performance.now();
    const recs = await search.conversationRecords(top.source, top.targetUid, KEYWORD, 0, 5);
    console.log(
      `[unified-search] conversationRecords(${top.source},${top.targetUid}) took ${(performance.now() - t2).toFixed(0)}ms total=${recs.total}`,
    );
    for (const r of recs.items.slice(0, 3)) {
      console.log(
        `  seq=${r.msgSeq} time=${r.sendTime} sender=${r.senderUid} content=${r.content.slice(0, 50)}`,
      );
    }
  }

  const t3 = performance.now();
  const more = await search.moreSearch('file', KEYWORD, 0, 20);
  console.log(
    `[unified-search] moreSearch(file) took ${(performance.now() - t3).toFixed(0)}ms total=${more.total} items=${more.items.length}`,
  );

  session.dispose();
}

main().catch((e) => {
  console.error('[unified-search] failed:', e);
  process.exit(1);
});
