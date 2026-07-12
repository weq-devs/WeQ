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
 * ── The three tables, and how they're treated ──────────────────────────────
 *   nt_uid_mapping_table    — 配置/身份目录。**只写一次**（`ensureMapping`），存在即不
 *                             动，永不删。它的 sortNo(48901) 同时当会话 sortNo(40027)。
 *   c2c_msg_table           — 消息内容。**只新增不删除**（`insertTweetC2c`）。每次打开对
 *                             比本地推文列表，缺哪条补哪条；用推文的固定时间(40050)去重。
 *   recent_contact_v3_table — 会话列表。开启时写（`setContactLatest`，预览最新推文）、关
 *                             闭时删（`removeContact`）；从不动 mapping / c2c。
 *
 * 推文只有一类：内容 + 一个**固定在本地**的时间。本地那份 JSON（见 app 层 tweets.ts）
 * 才是唯一数据源；这里只负责把它注入库，绝不用「插入时刻」当消息时间。
 *
 * The avatar is a REAL local image file written under QQ's own
 * `nt_data/avatar/weq/` dir — QQ reads that absolute path (column 41110) to
 * render the conversation avatar, exactly like every other cached avatar.
 *
 * The ARK card's `coverUrl` / `url` point at our local HTTP server
 * (`http://127.0.0.1:<port>/…`); QQ fetches them to render the card cover and
 * open the jump page. When the port changes we rewrite the ARK body in place
 * (`rewriteArkPort` —— update, not delete).
 *
 * ⚠️ Writes to the live QQ databases + QQ's data dir. Run with QQ closed.
 */

import { copyFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import type { SqlValue } from '@weq/native';
import { QqDb, C2cMsgDb } from '@weq/db';
import { ProtoMsg, decodeElement, encodeElement, ElementType } from '@weq/codec';
import type { ArkElement } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { RecentContactBody } from '@weq/codec/proto/msg/40051';
import { avatarHashForUid } from './avatar_resource';

/** The real game-center account whose rows we clone as a structural template. */
const TEMPLATE_UID = 'u_-PBswiplK-7J7bmaQLA-mA';

/**
 * uin / 昵称固定；uid 不再硬编码。以前为了硬编码那套「真实」头像文件路径，只能把 uid
 * 也钉死成一个常量——全网所有安装共用同一个 `u_WeQ-assistant-fake01`，极易被 QQ 当成
 * 批量伪造账号风控。现在头像 hash 路径可由 uid 经 md5³ 公式（{@link avatarHashForUid}）
 * 实时算出，于是 uid 改成**每台机器随机生成一次并持久化**（见
 * `UserConfigService.getWeqAssistantUid`），由外部通过构造函数注入。
 */
export const WEQ_ASSISTANT_UIN = 2233445566n;
export const WEQ_ASSISTANT_NICK = 'WeQ助手';

/**
 * 生成一个 QQ 风格的随机 uid：`u_` 前缀 + 22 位取自 base64url 字符集 [A-Za-z0-9-_]
 * （与真实 QQ uid 同构）。仅在首次启用时生成一次，之后必须持久化复用：uid 一旦变化，
 * QQ 库里会残留旧 uid 的孤儿会话，且头像文件的 hash 路径也随之改变（对不上先前写入的图）。
 */
export function generateWeqAssistantUid(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; // 64 chars
  const bytes = randomBytes(22);
  let s = '';
  for (let i = 0; i < 22; i++) s += alphabet.charAt((bytes[i] ?? 0) % alphabet.length);
  return `u_${s}`;
}

const bodyCodec = new ProtoMsg(MsgBody);
const rcCodec = new ProtoMsg(RecentContactBody);

/**
 * One WeQ助手「推文」= one ARK card, keyed by a time that is **fixed in local
 * storage** (never the DB-insert moment). This is the render-facing slice the DB
 * layer needs; the authoritative record lives in the app-layer local store
 * (tweets.ts `WeqTweet`), which is structurally a superset of this.
 */
export interface WeqTweetCard {
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
  /**
   * **Fixed** unix seconds — the message time (written to 40050) AND the dedup
   * key deciding whether this 推文 is already in c2c. Fixed at local-save time,
   * never recomputed at insert.
   */
  createdAt: number;
}

export class WeqAssistantService {
  private readonly msgDb: QqDb;
  private readonly c2c: C2cMsgDb;
  /**
   * QQ 自己渲染这个会话头像时读的文件名 `s_<hash>` 与它的两位分片目录，均由 uid 经
   * md5³ 公式算出（`nt_data/avatar/user/<shard>/s_<hash>`）。uid 变则这两个值都变。
   */
  private readonly avatarHash: string;
  private readonly avatarShard: string;

  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
    /** 本机固定的 WeQ助手 uid（来自 userConfig：随机生成一次后持久化，保证幂等）。 */
    private readonly uid: string,
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
    const hash = avatarHashForUid(uid);
    this.avatarHash = `s_${hash}`;
    this.avatarShard = hash.slice(0, 2);
  }

  /**
   * ① mapping —— **只写一次**。存在即不动（永不删/永不改）。它的 sortNo(48901) 是整个
   * 会话的 sortNo，c2c(40027) / recent_contact(40027) 都复用它。
   */
  async ensureMapping(): Promise<void> {
    if (await this.exists()) return;
    const newSortNo = (await this.maxBigint('nt_uid_mapping_table', '48901')) + 1n;
    await this.cloneAndInsert('nt_uid_mapping_table', '48902', '"48901" DESC', {
      '48901': newSortNo,
      '48902': this.uid,
      '1002': WEQ_ASSISTANT_UIN,
    }, ['48912']);
  }

  /**
   * ② c2c —— 插入一条推文的 ARK 消息，**只新增不删除**。用推文的**固定时间**
   * (`card.createdAt` → 40050) 当去重键：库里已有同 uid 同时间的行则跳过（返回 false）。
   * 消息时间取本地固定值，绝不用插入时刻。
   */
  async insertTweetC2c(port: number, card: WeqTweetCard): Promise<boolean> {
    const timeBig = BigInt(card.createdAt);
    const dup = await this.msgDb.query(
      `SELECT 1 FROM c2c_msg_table WHERE "40021" = ? AND "40050" = ? LIMIT 1`,
      [this.uid, timeBig],
    );
    if (dup.length > 0) return false;

    const sortNo = await this.conversationSortNo();
    const msgId = (await this.maxBigint('c2c_msg_table', '40001')) + rand31();
    const arkJson = buildArkJson(port, card.createdAt, card);
    const body = await this.buildArkBody(arkJson);
    await this.cloneAndInsert('c2c_msg_table', '40021', '"40050" DESC', {
      '40001': msgId,
      '40002': rand31(),
      '40020': this.uid,
      '40021': this.uid,
      '40027': sortNo,
      '40030': WEQ_ASSISTANT_UIN,
      '40033': WEQ_ASSISTANT_UIN,
      '40050': timeBig,
      '40058': BigInt(localMidnightSec(card.createdAt)),
      '40800': body,
    }, ['40801', '40900', '40062']);
    return true;
  }

  /**
   * ③ recent_contact —— 写/替换会话列表行，让它预览 `card`（应传最新那篇推文）。会话时间
   * (40050/41136) 用该推文的固定时间。同时（若给了源图）刷新头像文件。整行先删后插以幂等。
   */
  async setContactLatest(port: number, card: WeqTweetCard, avatarSourcePath?: string): Promise<void> {
    const sortNo = await this.conversationSortNo();
    const avatarPath = this.writeAvatarFile(avatarSourcePath);
    const timeBig = BigInt(card.createdAt);

    // 指向该推文在 c2c 里的真实 msgId（按固定时间定位）。
    const rows = await this.msgDb.query(
      `SELECT "40001" FROM c2c_msg_table WHERE "40021" = ? AND "40050" = ? LIMIT 1`,
      [this.uid, timeBig],
    );
    const raw = rows[0]?.[0];
    const msgId = typeof raw === 'bigint' ? raw : typeof raw === 'number' ? BigInt(raw) : 0n;

    const arkJson = buildArkJson(port, card.createdAt, card);
    const previewBlob = rcCodec.encode({
      preview: {
        elementType: ElementType.ARK,
        arkData: arkJson,
        displayText: card.previewText,
        isSender: false,
      },
    });
    const recentOv: Record<string, SqlValue> = {
      '41102': (await this.maxBigint('recent_contact_v3_table', '41102')) + rand31(),
      '40010': 103n, // chatType (public account)
      '40011': 11n, // msgType (ark)
      '40027': sortNo,
      '40021': this.uid,
      '40020': this.uid,
      '40030': WEQ_ASSISTANT_UIN,
      '40033': WEQ_ASSISTANT_UIN,
      '40001': msgId,
      '40094': WEQ_ASSISTANT_NICK,
      '40050': timeBig,
      '41136': timeBig,
      '40051': previewBlob,
    };
    if (avatarPath) recentOv['41110'] = avatarPath; // local avatar file for QQ

    await this.removeContact();
    await this.cloneAndInsert('recent_contact_v3_table', '40021', '"40050" DESC', recentOv);
  }

  /** 删除会话列表行（仅 recent_contact；mapping / c2c 一概不动）。关闭开关时调用。 */
  async removeContact(): Promise<void> {
    await this.msgDb.write(
      `DELETE FROM recent_contact_v3_table WHERE "40021" = ?`,
      [this.uid],
    );
  }

  /**
   * 发布单条推文进库（解耦调用的「注入数据库」这一步）：
   *   ensureMapping（只写一次）→ insertTweetC2c（缺才插）→ setContactLatest（预览它）。
   * 与本地写入（tweets.ts `addTweet`）配对：先写本地再 injectTweet。
   */
  async injectTweet(port: number, card: WeqTweetCard, avatarSourcePath?: string): Promise<void> {
    await this.ensureMapping();
    await this.insertTweetC2c(port, card);
    await this.setContactLatest(port, card, avatarSourcePath);
  }

  /**
   * 把整份本地推文列表同步进库（打开账号 / 开启开关时走这条）：
   *   ensureMapping → 逐条 insertTweetC2c（按固定时间去重，只补缺失）
   *   → rewriteArkPort（把已有行里嵌的端口刷成当前实际端口，改写≠删除）
   *   → setContactLatest（预览时间最新的那篇）。
   * `cards` 可乱序，内部按 createdAt 升序处理。
   */
  async syncTweets(port: number, cards: WeqTweetCard[], avatarSourcePath?: string): Promise<void> {
    await this.ensureMapping();
    const sorted = [...cards].sort((a, b) => a.createdAt - b.createdAt);
    for (const card of sorted) {
      await this.insertTweetC2c(port, card);
    }
    await this.rewriteArkPort(port); // keep every existing card's embedded port live
    const newest = sorted[sorted.length - 1];
    if (newest) await this.setContactLatest(port, newest, avatarSourcePath);
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
      [this.uid],
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
      [this.uid],
    );
    const rcBlob = rcRows[0]?.[0];
    if (rcBlob instanceof Uint8Array) {
      const rc = rcCodec.decode(rcBlob);
      if (rc.preview?.arkData) {
        const preview = { ...rc.preview, arkData: rewriteArkPort(rc.preview.arkData, newPort) };
        await this.msgDb.write(
          `UPDATE recent_contact_v3_table SET "40051" = ? WHERE "40021" = ?`,
          [rcCodec.encode({ preview }), this.uid],
        );
      }
    }
    return true;
  }

  /** Whether the WeQ助手 account already exists in this account's db. */
  async exists(): Promise<boolean> {
    const rows = await this.msgDb.query(
      `SELECT 1 FROM nt_uid_mapping_table WHERE "48902" = ? LIMIT 1`,
      [this.uid],
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
   * Overwrite the exact avatar file QQ derives for our fake uid
   * (`nt_data/avatar/user/<shard>/s_<hash>`, hash = md5³(uid)) with our logo. QQ
   * ignores column 41110 and renders from this hashed path, so this is the ONLY write
   * that actually changes the displayed avatar. Returns the absolute path
   * written (also stored in 41110 for our own bookkeeping), or null if no source
   * given / the account's nt_data dir can't be resolved.
   */
  private writeAvatarFile(sourcePath?: string): string | null {
    if (!sourcePath) return null;
    const ntData = this.platform.ntDataDir(this.session.context.uin);
    if (!ntData) return null;
    const dir = join(ntData, 'avatar', 'user', this.avatarShard);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, this.avatarHash);
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

  /** The conversation's sortNo (== mapping's 48901), reused as c2c/recent 40027. */
  private async conversationSortNo(): Promise<bigint> {
    const rows = await this.msgDb.query(
      `SELECT "48901" FROM nt_uid_mapping_table WHERE "48902" = ? LIMIT 1`,
      [this.uid],
    );
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
 * Build the ARK JSON for the WeQ助手 card. `timeSec` is the card's FIXED local
 * time. Most game-center ARK fields don't matter for rendering
 * (token/config/appid/adId/feedId…), so they're left empty or zero — QQ renders
 * from `view` + `meta.template3` (cover/title/text/url).
 */
export function buildArkJson(port: number, timeSec: number, card: WeqTweetCard): string {
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
        time: String(timeSec),
        title: card.title,
        url: `${base}${card.pagePath}`,
      },
    },
    prompt: card.prompt,
    sourceName: 'WeQ',
    ver: '0.0.3.67',
    view: 'pubAdArkView',
    config: { ctime: timeSec, token: '' },
  });
}

/** Local-midnight (00:00, local tz) of a fixed unix-seconds timestamp, in seconds. */
function localMidnightSec(unixSec: number): number {
  const d = new Date(unixSec * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
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
