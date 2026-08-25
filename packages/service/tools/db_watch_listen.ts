/**
 * Real-data listener probe: mount the nt_msg.db file watcher and print newly
 * inserted messages as they land, splitting private chats and group chats.
 *
 * Mirrors the app's live path:
 *   DbWatchService -> createNtMsgDbHook -> onDbChanged / onNewMessages
 * (see apps/desktop/src/main/context/app_context.ts).
 *
 * Detection diff is driven by `recent_contact_v3_table` seq watermarks, then
 * per-conversation `(40027,40003)` composite-index queries on the msg tables —
 * no full scans on the big tables (see startup diagnostics / EXPLAIN output).
 *
 * The hook only touches session fields listed in nt_msg_hook.ts, so instead of
 * spinning up a full AccountSession (which needs a Platform) we hand it a
 * minimal session-shaped object built straight from `.env`.
 *
 * Run:  pnpm --filter @weq/service tools:db-watch-listen
 *
 * Env (from the repo-root `.env`, see .env.example):
 *   WEQ_TEST_QQ_ROOT   nt_qq root (derives nt_msg.db path)
 *   WEQ_TEST_DB_KEY    SQLCipher key
 *   WEQ_TEST_UIN       account QQ number (informational here)
 *
 * First run only aligns the seq watermarks (no history replay); new rows after
 * that are printed. Ctrl+C to stop.
 */

import type { Element } from '@weq/codec';
import type { C2cMsg, GroupMsg } from '@weq/db';
import { C2cMsgDb, GroupMsgDb, QqDb, RecentContactDb, UidMap, UidMappingDb } from '@weq/db';
import { loadNative } from '@weq/native';
import { createNtMsgDbHook, DbWatchService } from '@weq/service';
import { testEnv } from '@weq/testkit';
import type { AccountSession } from '@weq/account';

const DB_PATH = testEnv.msgDbPath;
const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;

/** "text" / "at" elements carry a textContent; everything else gets a tag. */
function summarizeElements(elements: Element[]): string {
  if (elements.length === 0) return '(no elements)';
  const parts = elements.map((el) => {
    if (el.kind === 'text' || el.kind === 'at') return el.textContent;
    return `[${el.kind}]`;
  });
  return parts.join(' ');
}

function formatTime(epochSeconds: bigint): string {
  const d = new Date(Number(epochSeconds) * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function printC2c(msgs: C2cMsg[]): void {
  for (const m of msgs) {
    console.log(
      `[私聊] ${formatTime(m.sendTime)} 目标=${m.targetUid}(${m.targetUin}) ` +
        `发送者=${m.senderUid}(${m.senderUin}) seq=${m.msgSeq} msgId=${m.msgId}`,
    );
    console.log(`        内容: ${summarizeElements(m.elements)}`);
  }
}

function printGroup(msgs: GroupMsg[]): void {
  for (const m of msgs) {
    console.log(
      `[群聊] ${formatTime(m.sendTime)} 群=${m.targetGroupCode} ` +
        `发送者=${m.senderUid}(${m.senderUin}) seq=${m.msgSeq} msgId=${m.msgId}`,
    );
    console.log(`        内容: ${summarizeElements(m.elements)}`);
  }
}

/** One-time schema/index/plan diagnostics. Confirms the msg-table queries are indexed. */
async function runDiagnostics(diag: QqDb): Promise<void> {
  for (const table of ['recent_contact_v3_table', 'c2c_msg_table', 'group_msg_table']) {
    console.log(`\n===== ${table} =====`);
    const ddl = await diag.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [table],
    );
    console.log(`DDL: ${String(ddl[0]?.[0] ?? '(not found)')}`);

    const indexes = await diag.query(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`,
      [table],
    );
    console.log(`indexes (${indexes.length}):`);
    for (const r of indexes) {
      console.log(`  ${String(r[0])}: ${String(r[1] ?? '(auto)')}`);
    }
  }

  console.log('\n===== EXPLAIN QUERY PLAN =====');
  const plans: [string, string][] = [
    [
      'recent_contact watermark read',
      `SELECT "40021","40010","40003","40050" FROM recent_contact_v3_table`,
    ],
    [
      'group per-conv new rows (must hit (40027,40003))',
      `SELECT "40001" FROM group_msg_table WHERE "40027" = '1' AND "40003" > 0 ORDER BY "40003" ASC LIMIT 1`,
    ],
    [
      'c2c per-conv new rows via sortNo (must hit (40027,40003))',
      `SELECT "40001" FROM c2c_msg_table WHERE "40027" = 1 AND "40003" > 0 ORDER BY "40003" ASC LIMIT 1`,
    ],
  ];
  for (const [label, sql] of plans) {
    const plan = await diag.query(`EXPLAIN QUERY PLAN ${sql}`);
    console.log(`- ${label}:`);
    for (const r of plan) console.log(`    ${String(r[3])}`);
  }
}

async function main(): Promise<void> {
  const native = loadNative();
  const diag = new QqDb(native.ntHelper, { dbPath: DB_PATH, key: KEY, algo: ALGO });
  const c2cMsgs = new C2cMsgDb(native.ntHelper, { dbPath: DB_PATH, key: KEY, algo: ALGO });
  const groupMsgs = new GroupMsgDb(native.ntHelper, { dbPath: DB_PATH, key: KEY, algo: ALGO });
  const recentContacts = new RecentContactDb(native.ntHelper, { dbPath: DB_PATH, key: KEY, algo: ALGO });
  const uidMap = UidMap.from(
    await new UidMappingDb(native.ntHelper, { dbPath: DB_PATH, key: KEY, algo: ALGO }).listAll(),
  );

  await runDiagnostics(diag);

  const t0 = Date.now();
  const watermarks = await recentContacts.listSeqWatermarks();
  console.log(
    `\n[diag] recent_contact_v3_table watermark read: ${watermarks.length} rows (${Date.now() - t0}ms)`,
  );
  console.log(`[diag] uid map size: ${uidMap.size}`);

  // The hook only reads these members; see nt_msg_hook.ts.
  const session = {
    msgDbPath: DB_PATH,
    lastRowIdMaps: { c2cRowId: 0n, groupRowId: 0n, guildRowId: 0n },
    c2cMsgs,
    groupMsgs,
    recentContacts,
    uidMap,
  } as unknown as AccountSession;

  const watch = new DbWatchService({ intervalMs: 1000 });
  const handle = watch.mount(
    createNtMsgDbHook(session, {
      onDbChanged: (file) => {
        console.log(
          `[db] nt_msg.db changed: total=${file.total} delta=${file.delta >= 0 ? '+' : ''}${file.delta}`,
        );
      },
      onNewMessages: ({ c2c, group }) => {
        console.log(`[db] 新消息 ${c2c.length} 条私聊 / ${group.length} 条群聊`);
        if (c2c.length > 0) printC2c(c2c);
        if (group.length > 0) printGroup(group);
        console.log('---');
      },
    }),
  );

  console.log(`[listen] 已挂载监听: ${DB_PATH}`);
  console.log(`[listen] 首次对齐会话 seq 水印（${watermarks.length} 个会话），不打印历史`);
  console.log('[listen] 等待新消息... Ctrl+C 停止');

  // DbWatchService's poll timer is unref'd, so hold the event loop open.
  const keepAlive = setInterval(() => {}, 60_000);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[listen] ${signal}, 停止监听`);
    clearInterval(keepAlive);
    handle.unmount();
    diag.close();
    c2cMsgs.close();
    groupMsgs.close();
    recentContacts.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('[listen] failed:', e);
  process.exit(1);
});