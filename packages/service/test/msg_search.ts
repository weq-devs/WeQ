/**
 * Test — MsgSearchService over a real account session.
 *
 * Drives the full service → AccountSession → BuddyMsgFtsDb → buddy_msg_fts.db
 * pipeline, exactly as the IPC layer would. Provide a keyword as the first arg.
 *
 * Run:  pnpm --filter @weq/service test:msg-search -- <keyword>
 *   or: WEQ_TEST_KEYWORD=分期 pnpm --filter @weq/service test:msg-search
 *
 * Env (defaults to the shared dev test account):
 *   WEQ_TEST_UIN     QQ number whose nt_db folder to open
 *   WEQ_TEST_DB_KEY  SQLCipher key for that account
 */

import { openAccount } from '@weq/account';
import { loadNative } from '@weq/native';
import { createWin32Platform } from '@weq/platform';
import { MsgSearchService } from '../src/account/msg_search';

const UIN = process.env.WEQ_TEST_UIN ?? '1707889225';
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
// pnpm forwards a literal `--` separator into argv; drop it before reading.
const KEYWORD =
  process.argv.slice(2).find((a) => a !== '--') ?? process.env.WEQ_TEST_KEYWORD ?? '你好';

async function main(): Promise<void> {
  const platform = createWin32Platform(loadNative());
  const session = openAccount(platform, { uin: UIN, dbKey: KEY });
  const search = new MsgSearchService(session);

  console.log(`[test:msg-search] uin=${UIN} keyword="${KEYWORD}"`);
  const hits = await search.search(KEYWORD, 10);
  console.log(`[test:msg-search] → ${hits.length} hit(s), best match first:`);

  for (const h of hits) {
    const preview = h.content.length > 60 ? `${h.content.slice(0, 60)}…` : h.content;
    console.log(
      `  msgId=${h.msgId} chatType=${h.chatType} target=${h.targetUid} sender=${h.senderUid}`,
    );
    console.log(`    ${preview}`);
  }

  session.dispose();
}

main().catch((e) => {
  console.error('[test:msg-search] failed:', e);
  process.exit(1);
});
