/**
 * Fabricate a brand-new fake account — "WeQ助手" — that does NOT exist in QQ.
 *
 * QQ 游戏中心 (uid u_-PBswiplK-7J7bmaQLA-mA) is a *public account*
 * (chatType=103, msgType=11) whose messages are a single ARK card
 * (view: pubAdArkView). We reuse its rows as structurally-identical templates:
 * clone the game-center row from each table, then override ONLY the identity +
 * content columns for our fake account. Every opaque flag column rides along
 * verbatim (the proven "clone a sibling row" pattern from append.ts).
 *
 * Tables written (2 databases):
 *   nt_msg.db       : nt_uid_mapping_table   (uid ↔ uin ↔ sortNo directory)
 *                     c2c_msg_table          (one fake ARK message)
 *                     recent_contact_v3_table(recent-list entry + preview)
 *   profile_info.db : profile_info_v6        (detailed profile)
 *                     profile_info_public_account (public-account row)
 *
 * Idempotent: existing rows for FAKE_UID are deleted first, so re-running
 * replaces rather than duplicates.
 *
 * ⚠️ WRITES to the live QQ databases. Back up nt_msg.db + profile_info.db and
 *    run with QQ fully closed. Set WEQ_DRY_RUN=1 to print the planned rows
 *    without writing.
 *
 * Run:  pnpm --filter @weq/db test:insert-weq-assistant
 */

import { loadNative } from '@weq/native';
import type { SqlValue } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { ProtoMsg, decodeElement, encodeElement, ElementType } from '@weq/codec';
import type { ArkElement } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { RecentContactBody } from '@weq/codec/proto/msg/40051';

// ─── config ────────────────────────────────────────────────────────────────
const UIN_ME = process.env.WEQ_TEST_UIN ?? '1707889225';
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const BASE = `D:\\estkim\\T\\Tencent Files\\${UIN_ME}\\nt_qq\\nt_db`;
const MSG_DB_PATH = process.env.WEQ_TEST_DB_PATH ?? `${BASE}\\nt_msg.db`;
const PROFILE_DB_PATH = process.env.WEQ_TEST_PROFILE_DB_PATH ?? `${BASE}\\profile_info.db`;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DRY_RUN = !!process.env.WEQ_DRY_RUN;

/**
 * Whether to write the two profile_info.db tables. Default OFF: those tables
 * carry FTS5 triggers declared with `tokenize = 'pinyin_letter'` (QQ's own
 * tokenizer, not registered in our SQLCipher build), so any INSERT/DELETE on
 * them dies with `no such tokenizer: pinyin_letter`. The nt_msg.db tables have
 * no such triggers and write fine — enough to make the account appear in the
 * recent list + open the conversation. Set WEQ_WRITE_PROFILE=1 to attempt them.
 */
const WRITE_PROFILE = !!process.env.WEQ_WRITE_PROFILE;

/** The real game-center account we clone templates from. */
const TEMPLATE_UID = 'u_-PBswiplK-7J7bmaQLA-mA';

/** Our fabricated account (uid + uin made up — must not collide with a real peer). */
const FAKE_UID = process.env.WEQ_FAKE_UID ?? 'u_WeQ-assistant-fake01';
const FAKE_UIN = BigInt(process.env.WEQ_FAKE_UIN ?? '2233445566');
const NICK = 'WeQ助手';

/** Reused from game-center's profile_info_v6.20004 — temporary avatar (外链). */
const GAME_CENTER_AVATAR_URL =
  'http://qh.qlogo.cn/g?b=qq&ek=AQKQPaWgmgicoGibuSNjw0gnMZib9SXGMPsXOX1QVjI7ckibzxAGavoP8zGibNiaeJygyrOO8zKr6krK0jhUdzd6IGANZKhrAOgxhXiaX79wH3kXLeD9AUG2OugfDf8dJBkLg&s=';

const bodyCodec = new ProtoMsg(MsgBody);
const rcCodec = new ProtoMsg(RecentContactBody);

// ─── helpers ─────────────────────────────────────────────────────────────
function describe(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof Uint8Array) return `<BLOB ${v.byteLength} bytes>`;
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'string') return v.length > 80 ? `"${v.slice(0, 80)}…"` : `"${v}"`;
  return String(v);
}

/** Random 31-bit positive bigint (for msgRandom / id jitter). */
function rand31(): bigint {
  return BigInt(1 + Math.floor(Math.random() * 0x7fffffff));
}

async function maxBigint(db: QqDb, table: string, col: string): Promise<bigint> {
  const rows = await db.query(`SELECT MAX("${col}") FROM "${table}"`);
  const v = rows[0]?.[0];
  return typeof v === 'bigint' ? v : typeof v === 'number' ? BigInt(v) : 0n;
}

/**
 * Clone one template row (game-center) and INSERT it back with per-column
 * overrides applied. Returns the values actually inserted (for logging).
 */
async function cloneAndInsert(
  db: QqDb,
  table: string,
  templateWhereCol: string,
  templateWhereVal: SqlValue,
  orderBy: string,
  overrides: Record<string, SqlValue>,
  nullCols: string[] = [],
): Promise<{ cols: string[]; values: SqlValue[] }> {
  const info = await db.query(`PRAGMA table_info("${table}")`);
  const cols = info.map((r) => String(r[1]));
  const quoted = cols.map((c) => `"${c}"`).join(',');
  const idx = (c: string): number => {
    const i = cols.indexOf(c);
    if (i < 0) throw new Error(`[${table}] column ${c} not found`);
    return i;
  };

  const tmpl = await db.query(
    `SELECT ${quoted} FROM "${table}" WHERE "${templateWhereCol}" = ? ORDER BY ${orderBy} LIMIT 1`,
    [templateWhereVal],
  );
  if (tmpl.length === 0) {
    throw new Error(`[${table}] no template row for ${templateWhereCol}=${String(templateWhereVal)}`);
  }

  const values = [...tmpl[0]!] as SqlValue[];
  for (const [col, val] of Object.entries(overrides)) values[idx(col)] = val;
  for (const c of nullCols) values[idx(c)] = null;

  if (!DRY_RUN) {
    const placeholders = cols.map(() => '?').join(',');
    await db.write(`INSERT INTO "${table}" (${quoted}) VALUES (${placeholders})`, values);
  }
  return { cols, values };
}

/** Log which overridden columns went in. */
function logInserted(table: string, cols: string[], values: SqlValue[], overrideKeys: string[]): void {
  console.log(`\n[${table}] ${DRY_RUN ? 'PLANNED' : 'inserted'} — overrides:`);
  for (const c of overrideKeys) {
    const i = cols.indexOf(c);
    if (i >= 0) console.log(`    ${c.padEnd(8)} = ${describe(values[i])}`);
  }
}

/** Build the WeQ助手 ARK JSON payload (pubAdArkView shape). */
function buildArkJson(nowSec: number): string {
  return JSON.stringify({
    app: 'com.tencent.gamecenter.mall',
    desc: 'WeQ 助手',
    meta: {
      template3: {
        __preloadFields: 'coverUrl',
        actId: 0,
        actTitle: 'WeQ助手',
        adId: '0',
        appid: '0',
        arkType: 'pubSinglePicArk',
        buttonType: 0,
        contentText: '我是 WeQ 助手，很高兴为你服务～',
        coverUrl: GAME_CENTER_AVATAR_URL,
        feedId: 0,
        fid: 0,
        five_element_switch: false,
        is_colorful: false,
        styleType: 1,
        time: String(nowSec),
        title: 'WeQ 助手已上线',
        url: 'https://github.com/',
      },
    },
    prompt: 'WeQ 助手已上线',
    sourceName: 'WeQ',
    ver: '0.0.3.67',
    view: 'pubAdArkView',
    config: { ctime: nowSec, token: 'weqweqweqweqweqweqweqweqweqweqwe0' },
  });
}

// ─── main ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const native = loadNative();
  const msgDb = new QqDb(native.ntHelper, { dbPath: MSG_DB_PATH, key: KEY, algo: ALGO });
  const profileDb = new QqDb(native.ntHelper, { dbPath: PROFILE_DB_PATH, key: KEY, algo: ALGO });

  console.log(`[weq-assistant] ${DRY_RUN ? 'DRY RUN (no writes)' : 'WRITING'} — fake account:`);
  console.log(`    uid = ${FAKE_UID}`);
  console.log(`    uin = ${FAKE_UIN}n`);
  console.log(`    nick= ${NICK}`);

  // Fresh, collision-free ids.
  const nowSec = Math.floor(Date.now() / 1000);
  const nowSecBig = BigInt(nowSec);
  const nowMsBig = BigInt(nowSec) * 1000n;
  const midnightSec = BigInt(Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000));

  const newSortNo = (await maxBigint(msgDb, 'nt_uid_mapping_table', '48901')) + 1n;
  const newMsgId = (await maxBigint(msgDb, 'c2c_msg_table', '40001')) + rand31();
  const newMsgRandom = rand31();
  const newRecentPk = (await maxBigint(msgDb, 'recent_contact_v3_table', '41102')) + rand31();

  console.log(`\n[ids] sortNo=${newSortNo}n  msgId=${newMsgId}n  msgRandom=${newMsgRandom}n  recentPk=${newRecentPk}n`);

  // Build the new ARK message body: clone game-center's newest c2c body, swap
  // the ark payload (proven round-trip from test-ark-modify).
  const arkJson = buildArkJson(nowSec);
  const tmplBodyRows = await msgDb.query(
    `SELECT "40800" FROM c2c_msg_table WHERE "40021" = ? ORDER BY "40050" DESC LIMIT 1`,
    [TEMPLATE_UID],
  );
  const tmplBlob = tmplBodyRows[0]?.[0];
  if (!(tmplBlob instanceof Uint8Array)) throw new Error('no game-center c2c body to use as template');
  const decoded = bodyCodec.decode(tmplBlob);
  const elements = (decoded.elements ?? []).map(decodeElement);
  const arkEl = elements.find((e) => e.kind === 'ark') as ArkElement | undefined;
  if (!arkEl) throw new Error('game-center template message has no ark element');
  arkEl.arkData = arkJson;
  const newBody = bodyCodec.encode({ elements: elements.map(encodeElement) });
  console.log(`\n[ark] built new msgBody (${newBody.byteLength} bytes) with WeQ助手 payload`);

  // Build the recent-list preview blob (40051): a single ark preview element +
  // the conversation-list display text (tag 49093).
  const previewBlob = rcCodec.encode({
    preview: {
      elementType: ElementType.ARK,
      arkData: arkJson,
      displayText: '[WeQ助手] WeQ 助手已上线',
      isSender: false,
    },
  });

  // ── cleanup any prior fake rows (idempotent re-run) ───────────────────
  const cleanup: Array<[QqDb, string, string]> = [
    [msgDb, 'nt_uid_mapping_table', '48902'],
    [msgDb, 'c2c_msg_table', '40021'],
    [msgDb, 'recent_contact_v3_table', '40021'],
    ...(WRITE_PROFILE
      ? ([
          [profileDb, 'profile_info_v6', '1000'],
          [profileDb, 'profile_info_public_account', '1000'],
        ] as Array<[QqDb, string, string]>)
      : []),
  ];
  if (!DRY_RUN) {
    console.log('\n[cleanup] removing any existing rows for the fake uid…');
    for (const [db, table, col] of cleanup) {
      const n = await db.write(`DELETE FROM "${table}" WHERE "${col}" = ?`, [FAKE_UID]);
      if (n > 0) console.log(`    ${table}: deleted ${n}`);
    }
  }

  // ── 1) nt_uid_mapping_table ───────────────────────────────────────────
  {
    const ov: Record<string, SqlValue> = { '48901': newSortNo, '48902': FAKE_UID, '1002': FAKE_UIN };
    const { cols, values } = await cloneAndInsert(
      msgDb, 'nt_uid_mapping_table', '48902', TEMPLATE_UID, '"48901" DESC', ov, ['48912'],
    );
    logInserted('nt_uid_mapping_table', cols, values, Object.keys(ov));
  }

  // ── 2) c2c_msg_table (the ARK message) ────────────────────────────────
  {
    const ov: Record<string, SqlValue> = {
      '40001': newMsgId,          // msgId (PK)
      '40002': newMsgRandom,      // msgRandom (part of UNIQUE(40027,40002,40005))
      '40020': FAKE_UID,          // senderUid
      '40021': FAKE_UID,          // targetUid
      '40027': newSortNo,         // sortNo (partition key)
      '40030': FAKE_UIN,          // targetUin
      '40033': FAKE_UIN,          // senderUin
      '40050': nowSecBig,         // sendTime
      '40058': midnightSec,       // dayTimestamp
      '40800': newBody,           // msgBody (new ark)
    };
    // Null the display-text / source caches so they get rebuilt (per append.ts).
    const { cols, values } = await cloneAndInsert(
      msgDb, 'c2c_msg_table', '40021', TEMPLATE_UID, '"40050" DESC', ov, ['40801', '40900', '40062'],
    );
    logInserted('c2c_msg_table', cols, values, Object.keys(ov));
  }

  // ── 3) recent_contact_v3_table ────────────────────────────────────────
  {
    const ov: Record<string, SqlValue> = {
      '41102': newRecentPk,       // PK
      '40010': 103n,              // chatType (public account) — inherited, set explicit
      '40011': 11n,               // msgType (ark) — inherited, set explicit
      '40027': newSortNo,
      '40021': FAKE_UID,          // targetUid
      '40020': FAKE_UID,          // senderUid
      '40030': FAKE_UIN,          // targetUin
      '40033': FAKE_UIN,          // senderUin
      '40001': newMsgId,          // link to the c2c message
      '40094': NICK,              // targetDisplayName → "WeQ助手"
      '40050': nowSecBig,         // sendTime
      '41136': nowSecBig,         // mirror time
      '40051': previewBlob,       // preview (ark + displayText)
      // 41110 (local avatar path) rides along from game-center as a temp stand-in.
    };
    const { cols, values } = await cloneAndInsert(
      msgDb, 'recent_contact_v3_table', '40021', TEMPLATE_UID, '"40050" DESC', ov,
    );
    logInserted('recent_contact_v3_table', cols, values, [...Object.keys(ov), '41110']);
  }

  // ── 4 & 5) profile_info.db tables — gated behind WRITE_PROFILE ─────────
  // These carry FTS5 `pinyin_letter` triggers our SQLCipher build can't run,
  // so they're skipped by default (see WRITE_PROFILE doc).
  if (WRITE_PROFILE) {
    // profile_info_v6
    {
      const ov: Record<string, SqlValue> = {
        '1000': FAKE_UID,
        '1002': FAKE_UIN,
        '20002': NICK,              // nick
        '20004': GAME_CENTER_AVATAR_URL, // avatarUrl (外链, 暂借游戏中心)
      };
      const { cols, values } = await cloneAndInsert(
        profileDb, 'profile_info_v6', '1000', TEMPLATE_UID, '"1000"', ov, ['20017'],
      );
      logInserted('profile_info_v6', cols, values, Object.keys(ov));
    }
    // profile_info_public_account
    {
      const ov: Record<string, SqlValue> = {
        '1000': FAKE_UID,
        '1002': FAKE_UIN,
        '20002': NICK,
        '410002': nowMsBig,         // last-active ms
      };
      const { cols, values } = await cloneAndInsert(
        profileDb, 'profile_info_public_account', '1000', TEMPLATE_UID, '"1000"', ov,
      );
      logInserted('profile_info_public_account', cols, values, Object.keys(ov));
    }
  } else {
    console.log('\n[profile] skipped profile_info_v6 + profile_info_public_account (WRITE_PROFILE unset).');
  }

  // ── verify ────────────────────────────────────────────────────────────
  if (!DRY_RUN) {
    console.log('\n================ verify (re-query fake uid) ================');
    const checks: Array<[QqDb, string, string, string]> = [
      [msgDb, 'nt_uid_mapping_table', '48902', '"48901","48902","1002"'],
      [msgDb, 'c2c_msg_table', '40021', '"40001","40011","40021","40027","40033"'],
      [msgDb, 'recent_contact_v3_table', '40021', '"41102","40010","40094","40021"'],
      ...(WRITE_PROFILE
        ? ([
            [profileDb, 'profile_info_v6', '1000', '"1000","1002","20002","20004"'],
            [profileDb, 'profile_info_public_account', '1000', '"1000","1002","20002"'],
          ] as Array<[QqDb, string, string, string]>)
        : []),
    ];
    for (const [db, table, col, sel] of checks) {
      const rows = await db.query(`SELECT ${sel} FROM "${table}" WHERE "${col}" = ?`, [FAKE_UID]);
      console.log(`  ${table.padEnd(28)} rows=${rows.length}  ${rows[0] ? rows[0].map(describe).join('  ') : ''}`);
    }
  }

  msgDb.close();
  profileDb.close();
  console.log(`\n[weq-assistant] done${DRY_RUN ? ' (dry run — nothing written)' : ''}.`);
}

main().catch((e) => {
  console.error('[weq-assistant] failed:', e);
  process.exit(1);
});
