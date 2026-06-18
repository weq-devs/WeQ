/**
 * Test — aggregated buddy + group FTS search, with timing.
 *
 * Mirrors the IPC `searchMessages` scope='all' path: run `searchBuddy` and
 * `searchGroup` in parallel, merge by sendTime desc, trim to limit. Reports
 * per-source and wall-clock timing, and repeats a few times so the cold (first
 * decrypt/open) vs warm (native connection cached) cost is visible.
 *
 * Run:  pnpm --filter @weq/service test:msg-search-agg -- 50da8a09
 *   or: WEQ_TEST_KEYWORD=50da8a09 pnpm --filter @weq/service test:msg-search-agg
 *
 * Env (defaults to the shared dev test account):
 *   WEQ_TEST_UIN     QQ number whose nt_db folder to open
 *   WEQ_TEST_DB_KEY  SQLCipher key for that account
 */

import { performance } from 'node:perf_hooks';
import { openAccount } from '@weq/account';
import { loadNative } from '@weq/native';
import { createWin32Platform } from '@weq/platform';
import type { BuddyMsgFtsHit } from '@weq/db';
import { MsgSearchService } from '../src/account/msg_search';

const UIN = process.env.WEQ_TEST_UIN ?? '1707889225';
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
// pnpm forwards a literal `--` separator into argv; drop it before reading.
const KEYWORD =
  process.argv.slice(2).find((a) => a !== '--') ?? process.env.WEQ_TEST_KEYWORD ?? '50da8a09';
const LIMIT = 20;
const RUNS = 3;

/** Run buddy + group concurrently and merge, exactly like IPC scope='all'. */
async function aggregateSearch(
  search: MsgSearchService,
  keyword: string,
  limit: number,
): Promise<{ merged: BuddyMsgFtsHit[]; buddyMs: number; groupMs: number; buddyN: number; groupN: number; totalMs: number }> {
  const t0 = performance.now();
  let buddyMs = 0;
  let groupMs = 0;
  const [buddy, group] = await Promise.all([
    (async () => {
      const s = performance.now();
      const r = await search.searchBuddy(keyword, limit);
      buddyMs = performance.now() - s;
      return r;
    })(),
    (async () => {
      const s = performance.now();
      const r = await search.searchGroup(keyword, limit);
      groupMs = performance.now() - s;
      return r;
    })(),
  ]);
  const merged = [...buddy, ...group]
    .sort((a, b) => Number(b.sendTime - a.sendTime))
    .slice(0, limit);
  return { merged, buddyMs, groupMs, buddyN: buddy.length, groupN: group.length, totalMs: performance.now() - t0 };
}

async function main(): Promise<void> {
  const platform = createWin32Platform(loadNative());
  const session = await openAccount(platform, {
    uin: UIN,
    dbKey: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });
  const search = new MsgSearchService(session);

  console.log(`[test:msg-search-agg] uin=${UIN} keyword="${KEYWORD}" limit=${LIMIT}`);

  let last: Awaited<ReturnType<typeof aggregateSearch>> | null = null;
  for (let i = 0; i < RUNS; i += 1) {
    const r = await aggregateSearch(search, KEYWORD, LIMIT);
    last = r;
    const tag = i === 0 ? 'cold' : `warm#${i}`;
    console.log(
      `  [${tag}] total=${r.totalMs.toFixed(1)}ms  ` +
        `buddy=${r.buddyMs.toFixed(1)}ms(${r.buddyN})  group=${r.groupMs.toFixed(1)}ms(${r.groupN})  ` +
        `merged=${r.merged.length}`,
    );
  }

  if (last) {
    console.log(`\n[test:msg-search-agg] top ${last.merged.length} merged hit(s), newest first:`);
    for (const h of last.merged) {
      const preview = h.content.length > 60 ? `${h.content.slice(0, 60)}…` : h.content;
      console.log(
        `  sendTime=${h.sendTime} msgId=${h.msgId} chatType=${h.chatType} target=${h.targetUid} sender=${h.senderUid}`,
      );
      console.log(`    ${preview}`);
    }
  }

  session.dispose();
}

main().catch((e) => {
  console.error('[test:msg-search-agg] failed:', e);
  process.exit(1);
});
