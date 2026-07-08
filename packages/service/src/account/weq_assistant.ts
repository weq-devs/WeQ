/**
 * WeqAssistantService — fabricate & maintain the built-in "WeQ助手" account
 * inside the LIVE QQ NT databases so it shows up **in QQ itself** (not WeQ).
 *
 * WeQ filters out chatType=103 (public-account) conversations, so this account
 * is invisible in WeQ by design — the whole point is to render it in the real
 * QQ client. QQ 游戏中心 (a public account, chatType=103, msgType=11, single ARK
 * card) is the structural template we clone: copy its row from each nt_msg.db
 * table, then override only the identity + content columns.
 *
 * What we write (nt_msg.db only — profile_info.db is skipped because its tables
 * carry FTS5 `pinyin_letter` triggers our SQLCipher build can't run):
 *   nt_uid_mapping_table    — uid ↔ uin ↔ sortNo directory entry
 *   c2c_msg_table           — one ARK message (cover + jump point at our server)
 *   recent_contact_v3_table — the recent-list entry (name/avatar/preview)
 *
 * The avatar is a REAL local image file written under QQ's own
 * `nt_data/avatar/weq/` dir — QQ reads that absolute path (column 41110) to
 * render the conversation avatar, exactly like every other cached avatar.
 *
 * The ARK card's `coverUrl` / `url` point at our local HTTP server
 * (`http://127.0.0.1:<port>/…`); QQ fetches them to render the card cover and
 * open the jump page. When the port changes we rewrite the ARK body in place.
 *
 * ⚠️ Writes to the live QQ databases + QQ's data dir. Run with QQ closed.
 */

import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import type { SqlValue } from '@weq/native';
import { QqDb, C2cMsgDb } from '@weq/db';
import { ProtoMsg, decodeElement, encodeElement, ElementType } from '@weq/codec';
import type { ArkElement } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { RecentContactBody } from '@weq/codec/proto/msg/40051';

/** The real game-center account whose rows we clone as a structural template. */
const TEMPLATE_UID = 'u_-PBswiplK-7J7bmaQLA-mA';

/** Our fabricated account. Fixed so re-runs are idempotent (delete-then-write). */
export const WEQ_ASSISTANT_UID = 'u_WeQ-assistant-fake01';
export const WEQ_ASSISTANT_UIN = 2233445566n;
export const WEQ_ASSISTANT_NICK = 'WeQ助手';

/**
 * Where QQ ITSELF looks for this account's avatar.
 *
 * QQ does NOT read the avatar path we write to column 41110 — it derives its own
 * cache path from the account's uid/uin (an opaque hash we can't reproduce) and
 * renders whatever image sits there. For our FIXED fake uid/uin that path is
 * constant, so we hard-code it and overwrite that exact file with our logo.
 *
 * Path shape: `nt_data/avatar/user/<hash[0:2]>/s_<hash>` (the 2-char shard dir
 * is the hash prefix). Empirically observed for uid=WEQ_ASSISTANT_UID /
 * uin=WEQ_ASSISTANT_UIN. If either identity constant changes, QQ will compute a
 * different hash and this must be re-observed.
 */
const AVATAR_HASH = 's_85179c05460bdec70b7320e6b1b039d4';
const AVATAR_SHARD = AVATAR_HASH.slice(2, 4); // 's_' + first 2 hex chars → '85'

const bodyCodec = new ProtoMsg(MsgBody);
const rcCodec = new ProtoMsg(RecentContactBody);

/**
 * One WeQ助手「推文」= one ARK card. Each becomes its own c2c message in the
 * fabricated conversation; the newest one drives the recent-list preview. Adding
 * a 推文 is just appending to {@link DEFAULT_CARDS} — no other surgery needed.
 */
export interface ArkCard {
  /** Server route for the cover PNG, e.g. `/cover/daily`. */
  coverPath: string;
  /** Server route for the click-through page, e.g. `/p/daily`. */
  pagePath: string;
  /** Card title line. */
  title: string;
  /** Card body text. */
  contentText: string;
  /** `prompt` (QQ notification / fallback text), e.g. `[WeQ助手] 每日推文`. */
  prompt: string;
  /** Recent-list preview line shown when this is the newest card. */
  previewText: string;
}

/**
 * The default 推文 set fabricated at init, oldest → newest. The LAST entry is the
 * newest message (drives the recent-list preview). "每日推文" 是首篇；"群数据周报"
 * 是统计推文（页面见 apps/.../weq_assistant/stats_page.ts）。
 */
export const DEFAULT_CARDS: ArkCard[] = [
  {
    coverPath: '/cover/daily',
    pagePath: '/p/daily',
    title: 'WeQ 助手 · 每日推文',
    contentText: '每日推文已送达，点击查看今日内容～',
    prompt: '[WeQ助手] 每日推文',
    previewText: '[WeQ助手] WeQ 助手已上线',
  },
  {
    coverPath: '/cover/stats',
    pagePath: '/p/stats',
    title: 'WeQ 助手 · 群数据周报',
    contentText: '你最活跃群聊的数据周报已生成，点击查看排行 / 活跃时段 / 词云～',
    prompt: '[WeQ助手] 群数据周报',
    previewText: '[WeQ助手] 群数据周报已生成',
  },
];

export interface EnsureAssistantOptions {
  /** Local server port embedded into the ARK card's coverUrl / jump url. */
  port: number;
  /**
   * Absolute path to the source avatar image (e.g. resources/brand/logo.png).
   * Copied into QQ's nt_data/avatar/weq dir. Omit to leave 41110 untouched.
   */
  avatarSourcePath?: string;
}

export interface EnsureAssistantResult {
  msgId: bigint;
  /** Absolute avatar path written to column 41110 (or null if not set). */
  avatarPath: string | null;
}

export class WeqAssistantService {
  private readonly msgDb: QqDb;
  private readonly c2c: C2cMsgDb;

  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
  ) {
    const { dbKey, algo } = session.context;
    this.msgDb = new QqDb(platform.native.ntHelper, {
      dbPath: session.msgDbPath,
      key: dbKey,
      algo,
    });
    this.c2c = new C2cMsgDb(platform.native.ntHelper, {
      dbPath: session.msgDbPath,
      key: dbKey,
      algo,
    });
  }

  /**
   * Create (or replace) the WeQ助手 account across the three nt_msg.db tables.
   * Idempotent: deletes any prior rows for our uid first. Returns the msgId of
   * the ARK message (persist it so port-change rewrites can find it fast).
   */
  async ensureAccount(opts: EnsureAssistantOptions): Promise<EnsureAssistantResult> {
    const nowSec = Math.floor(Date.now() / 1000);
    const nowSecBig = BigInt(nowSec);
    const midnightSec = BigInt(Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000));

    const cards = DEFAULT_CARDS;
    const newSortNo = (await this.maxBigint('nt_uid_mapping_table', '48901')) + 1n;
    let msgIdCursor = await this.maxBigint('c2c_msg_table', '40001');
    const newRecentPk = (await this.maxBigint('recent_contact_v3_table', '41102')) + rand31();

    // 1) Write the real avatar image into QQ's own data dir (QQ reads 41110).
    const avatarPath = this.writeAvatarFile(opts.avatarSourcePath);

    // ── cleanup prior rows (idempotent — removes ALL our rows across re-runs) ──
    for (const [table, col] of [
      ['nt_uid_mapping_table', '48902'],
      ['c2c_msg_table', '40021'],
      ['recent_contact_v3_table', '40021'],
    ] as const) {
      await this.msgDb.write(`DELETE FROM "${table}" WHERE "${col}" = ?`, [WEQ_ASSISTANT_UID]);
    }

    // ── 1) nt_uid_mapping_table (one directory entry, shared by all cards) ──
    await this.cloneAndInsert('nt_uid_mapping_table', '48902', '"48901" DESC', {
      '48901': newSortNo,
      '48902': WEQ_ASSISTANT_UID,
      '1002': WEQ_ASSISTANT_UIN,
    }, ['48912']);

    // ── 2) c2c_msg_table — one ARK message per 推文 (all share the conversation's
    //       sortNo/40027; only msgId/random/time differ). Timestamps increase with
    //       index so the LAST card is the newest message. ──
    let firstMsgId = 0n;
    let newestMsgId = 0n;
    let newestArkJson = '';
    for (let i = 0; i < cards.length; i += 1) {
      const card = cards[i]!;
      msgIdCursor += rand31(); // strictly increasing, collision-free
      const msgId = msgIdCursor;
      const cardTime = BigInt(nowSec - (cards.length - 1 - i)); // last card == nowSec
      const arkJson = buildArkJson(opts.port, Number(cardTime), card);
      const body = await this.buildArkBody(arkJson);
      await this.cloneAndInsert('c2c_msg_table', '40021', '"40050" DESC', {
        '40001': msgId,
        '40002': rand31(),
        '40020': WEQ_ASSISTANT_UID,
        '40021': WEQ_ASSISTANT_UID,
        '40027': newSortNo,
        '40030': WEQ_ASSISTANT_UIN,
        '40033': WEQ_ASSISTANT_UIN,
        '40050': cardTime,
        '40058': midnightSec,
        '40800': body,
      }, ['40801', '40900', '40062']);
      if (i === 0) firstMsgId = msgId;
      newestMsgId = msgId;
      newestArkJson = arkJson;
    }

    // ── 3) recent_contact_v3_table — one row, previewing the NEWEST card ──
    const newestCard = cards[cards.length - 1]!;
    const previewBlob = rcCodec.encode({
      preview: {
        elementType: ElementType.ARK,
        arkData: newestArkJson,
        displayText: newestCard.previewText,
        isSender: false,
      },
    });
    const recentOv: Record<string, SqlValue> = {
      '41102': newRecentPk,
      '40010': 103n, // chatType (public account)
      '40011': 11n, // msgType (ark)
      '40027': newSortNo,
      '40021': WEQ_ASSISTANT_UID,
      '40020': WEQ_ASSISTANT_UID,
      '40030': WEQ_ASSISTANT_UIN,
      '40033': WEQ_ASSISTANT_UIN,
      '40001': newestMsgId,
      '40094': WEQ_ASSISTANT_NICK,
      '40050': nowSecBig,
      '41136': nowSecBig,
      '40051': previewBlob,
    };
    if (avatarPath) recentOv['41110'] = avatarPath; // local avatar file for QQ
    await this.cloneAndInsert('recent_contact_v3_table', '40021', '"40050" DESC', recentOv);

    // Return the FIRST card's msgId for back-compat (config bookkeeping); the port
    // rewriter walks every card row by uid, so it no longer relies on this.
    return { msgId: firstMsgId, avatarPath };
  }

  /**
   * Rewrite the port embedded in EVERY 推文 card (coverUrl / url) + the recent-list
   * preview, in place — called when the server port changes. Walks all c2c rows
   * for our uid (there is one per card), so it stays correct as cards are added.
   * No-op (returns false) if the account hasn't been created yet.
   */
  async rewriteArkPort(newPort: number): Promise<boolean> {
    // Every ARK message row for our fabricated account.
    const rows = await this.msgDb.query(
      `SELECT "40001" FROM c2c_msg_table WHERE "40021" = ? ORDER BY "40050" ASC`,
      [WEQ_ASSISTANT_UID],
    );
    const ids = rows
      .map((r) => r[0])
      .map((v) => (typeof v === 'bigint' ? v : typeof v === 'number' ? BigInt(v) : null))
      .filter((v): v is bigint => v !== null);
    if (ids.length === 0) return false;

    for (const id of ids) {
      const blob = await this.c2c.getMsgBody(id);
      if (!blob) continue;
      const decoded = bodyCodec.decode(blob);
      const elements = (decoded.elements ?? []).map(decodeElement);
      const arkEl = elements.find((e) => e.kind === 'ark') as ArkElement | undefined;
      if (!arkEl) continue;
      arkEl.arkData = rewriteArkPort(arkEl.arkData, newPort);
      await this.c2c.updateMsgBody(id, bodyCodec.encode({ elements: elements.map(encodeElement) }));
    }

    // recent-contact preview (40051)
    const rcRows = await this.msgDb.query(
      `SELECT "40051" FROM recent_contact_v3_table WHERE "40021" = ? LIMIT 1`,
      [WEQ_ASSISTANT_UID],
    );
    const rcBlob = rcRows[0]?.[0];
    if (rcBlob instanceof Uint8Array) {
      const rc = rcCodec.decode(rcBlob);
      if (rc.preview?.arkData) {
        const preview = { ...rc.preview, arkData: rewriteArkPort(rc.preview.arkData, newPort) };
        await this.msgDb.write(
          `UPDATE recent_contact_v3_table SET "40051" = ? WHERE "40021" = ?`,
          [rcCodec.encode({ preview }), WEQ_ASSISTANT_UID],
        );
      }
    }
    return true;
  }

  /** Whether the WeQ助手 account already exists in this account's db. */
  async exists(): Promise<boolean> {
    const rows = await this.msgDb.query(
      `SELECT 1 FROM nt_uid_mapping_table WHERE "48902" = ? LIMIT 1`,
      [WEQ_ASSISTANT_UID],
    );
    return rows.length > 0;
  }

  // NOTE: intentionally NO close() — the underlying native connection for
  // nt_msg.db is cached per-path and SHARED with the open AccountSession
  // (session.c2cMsgs / recentContacts). Closing it here would yank the
  // connection out from under the live session. The session owns its lifecycle;
  // these QqDb handles just piggyback on the shared cache.

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Overwrite the exact avatar file QQ derives for our fake uid/uin
   * (`nt_data/avatar/user/<shard>/<AVATAR_HASH>`) with our logo. QQ ignores
   * column 41110 and renders from this hashed path, so this is the ONLY write
   * that actually changes the displayed avatar. Returns the absolute path
   * written (also stored in 41110 for our own bookkeeping), or null if no source
   * given / the account's nt_data dir can't be resolved.
   */
  private writeAvatarFile(sourcePath?: string): string | null {
    if (!sourcePath) return null;
    const ntData = this.platform.ntDataDir(this.session.context.uin);
    if (!ntData) return null;
    const dir = join(ntData, 'avatar', 'user', AVATAR_SHARD);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, AVATAR_HASH);
    copyFileSync(sourcePath, dest);
    return dest;
  }

  /** Clone game-center's newest c2c ARK body and swap in our arkData. */
  private async buildArkBody(arkJson: string): Promise<Uint8Array> {
    const rows = await this.msgDb.query(
      `SELECT "40800" FROM c2c_msg_table WHERE "40021" = ? ORDER BY "40050" DESC LIMIT 1`,
      [TEMPLATE_UID],
    );
    const blob = rows[0]?.[0];
    if (!(blob instanceof Uint8Array)) {
      throw new Error('[weq-assistant] no game-center template message to clone the ARK body from');
    }
    const decoded = bodyCodec.decode(blob);
    const elements = (decoded.elements ?? []).map(decodeElement);
    const arkEl = elements.find((e) => e.kind === 'ark') as ArkElement | undefined;
    if (!arkEl) throw new Error('[weq-assistant] game-center template has no ark element');
    arkEl.arkData = arkJson;
    return bodyCodec.encode({ elements: elements.map(encodeElement) });
  }

  private async maxBigint(table: string, col: string): Promise<bigint> {
    const rows = await this.msgDb.query(`SELECT MAX("${col}") FROM "${table}"`);
    const v = rows[0]?.[0];
    return typeof v === 'bigint' ? v : typeof v === 'number' ? BigInt(v) : 0n;
  }

  /**
   * Clone the game-center template row for `table` and INSERT it with the given
   * per-column overrides (and optional columns forced to NULL). Column order =
   * PRAGMA declaration order.
   */
  private async cloneAndInsert(
    table: string,
    templateWhereCol: string,
    orderBy: string,
    overrides: Record<string, SqlValue>,
    nullCols: string[] = [],
  ): Promise<void> {
    const info = await this.msgDb.query(`PRAGMA table_info("${table}")`);
    const cols = info.map((r) => String(r[1]));
    const quoted = cols.map((c) => `"${c}"`).join(',');
    const idx = (c: string): number => {
      const i = cols.indexOf(c);
      if (i < 0) throw new Error(`[weq-assistant] column ${c} not found in ${table}`);
      return i;
    };

    const tmpl = await this.msgDb.query(
      `SELECT ${quoted} FROM "${table}" WHERE "${templateWhereCol}" = ? ORDER BY ${orderBy} LIMIT 1`,
      [TEMPLATE_UID],
    );
    if (tmpl.length === 0) {
      throw new Error(`[weq-assistant] no template row in ${table} for ${TEMPLATE_UID}`);
    }

    const values = [...tmpl[0]!] as SqlValue[];
    for (const [c, v] of Object.entries(overrides)) values[idx(c)] = v;
    for (const c of nullCols) values[idx(c)] = null;

    const placeholders = cols.map(() => '?').join(',');
    await this.msgDb.write(`INSERT INTO "${table}" (${quoted}) VALUES (${placeholders})`, values);
  }
}

// ── ark payload helpers ────────────────────────────────────────────────────

/**
 * Build the ARK JSON for the WeQ助手 card. Most game-center ARK fields don't
 * matter for rendering (token/config/appid/adId/feedId…), so they're left empty
 * or zero — QQ renders from `view` + `meta.template3` (cover/title/text/url).
 */
export function buildArkJson(port: number, nowSec: number, card: ArkCard = DEFAULT_CARDS[0]!): string {
  const base = `http://127.0.0.1:${port}`;
  return JSON.stringify({
    app: 'com.tencent.gamecenter.mall',
    desc: 'WeQ 助手',
    meta: {
      template3: {
        __preloadFields: 'coverUrl',
        arkType: 'pubSinglePicArk',
        buttonType: 0,
        contentText: card.contentText,
        coverUrl: `${base}${card.coverPath}`,
        styleType: 1,
        time: String(nowSec),
        title: card.title,
        url: `${base}${card.pagePath}`,
      },
    },
    prompt: card.prompt,
    sourceName: 'WeQ',
    ver: '0.0.3.67',
    view: 'pubAdArkView',
    config: { ctime: nowSec, token: '' },
  });
}

/**
 * Swap the `127.0.0.1:<oldPort>` authority in an ARK JSON's coverUrl/url for the
 * new port. Parses + re-stringifies so we only touch our own local URLs.
 */
export function rewriteArkPort(arkData: string, newPort: number): string {
  try {
    const doc = JSON.parse(arkData) as {
      meta?: { template3?: { coverUrl?: string; url?: string } };
    };
    const t3 = doc.meta?.template3;
    if (t3) {
      if (t3.coverUrl) t3.coverUrl = swapLocalPort(t3.coverUrl, newPort);
      if (t3.url) t3.url = swapLocalPort(t3.url, newPort);
    }
    return JSON.stringify(doc);
  } catch {
    return arkData; // leave untouched if it isn't the shape we expect
  }
}

/** Replace the port of a `http://127.0.0.1:<port>/…` URL; other URLs untouched. */
function swapLocalPort(url: string, newPort: number): string {
  return url.replace(/^(https?:\/\/127\.0\.0\.1):\d+/, `$1:${newPort}`);
}

/** Random 31-bit positive bigint (msgId jitter / msgRandom). */
function rand31(): bigint {
  return BigInt(1 + Math.floor(Math.random() * 0x7fffffff));
}
