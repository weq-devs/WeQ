/**
 * `group_msg_table` — group-chat messages.
 *
 * Same column layout as c2c_msg_table, the conversation key being the group
 * code instead of a peer uid:
 *   40001  msgId           (INTEGER)
 *   40003  msgSeq          (INTEGER — per-group incrementing sequence)
 *   40020  senderUid       (TEXT)
 *   40027  targetGroupCode (INTEGER as text — 群号; conversation key, indexed)
 *   40033  senderUin       (INTEGER — sender QQ number)
 *   40040  sentSource      (INTEGER — 1 = locally originated / genuinely sent
 *                          by this account; 0 = sync copy, e.g. self-forwarded)
 *   40050  sendTime        (INTEGER, unix seconds)
 *   40058  dayTimestamp    (INTEGER — midnight timestamp of the day)
 *   40800  msgBody         (BLOB — protobuf repeated ElementWire)
 *   40062  setEmoji        (BLOB — protobuf repeated sticker reactions / 贴表情)
 *
 * Group code (40027) is the indexed partition key; all conversation queries
 * order by 40003 to hit the `(40027,40003)` composite index.
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import type { AtElement, Element, GrayTipPokeElement } from '@weq/codec';
import type {
  DressTally,
  GroupAtMeTop,
  GroupEchoLongest,
  GroupInteractionTally,
  GroupMsg,
  GroupTargetTop,
  SentSpeechRow,
  SentWeekdayHourlyGrid,
  SeqWindow,
} from './types';
import {
  buildWeekdayHourlyGrid,
  decodeBody,
  decodeEmoji,
  decodeDress,
  emptyDressTally,
  tallyDressBlobs,
  toBigint,
  toStr,
} from './util';
import { appendClonedRow, type AppendMsgFields, type AppendMsgResult } from './append';
import { QqDb } from '../qq_db';

const SELECT_COLUMNS = `"40001","40020","40027","40033","40050","40800","40062","40003","40011","40012","40801"`;

/**
 * Conversation ordering. 40003 alone is NOT a total order: gray tips share the
 * seq of the message they hang off (12631 colliding groups here), and the
 * UNIQUE `(40027,40003,40002)` index then breaks the tie on 40002 — a random —
 * so a same-seq run came back shuffled. Sending time then msgId settle it, and
 * keeping 40003 first still hits the `(40027,40003)` index.
 */
const ORDER_NEWEST_FIRST = `ORDER BY "40003" DESC, "40050" DESC, "40001" DESC`;
const ORDER_OLDEST_FIRST = `ORDER BY "40003" ASC, "40050" ASC, "40001" ASC`;

export interface GroupMsgDbOptions {
  /** Absolute path to nt_msg.db. */
  dbPath: string;
  /** SQLCipher key. (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

export class GroupMsgDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: GroupMsgDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /** Newest N messages in one group, newest-first (DESC by seq). */
  async listLatest(targetGroupCode: string, limit = 50): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40027" = ?
        ${ORDER_NEWEST_FIRST}
        LIMIT ?`,
      [targetGroupCode, BigInt(limit)],
    );
    return rows.map(rowToGroupMsg);
  }

  /** The page of messages just older than `beforeSeq` (exclusive), newest-first. */
  async listBefore(targetGroupCode: string, beforeSeq: bigint, limit = 50): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40027" = ? AND "40003" < ?
        ${ORDER_NEWEST_FIRST}
        LIMIT ?`,
      [targetGroupCode, beforeSeq, BigInt(limit)],
    );
    return rows.map(rowToGroupMsg);
  }

  /** The page of messages just newer than `afterSeq` (exclusive), oldest-first. */
  async listAfter(targetGroupCode: string, afterSeq: bigint, limit = 50): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40027" = ? AND "40003" > ?
        ${ORDER_OLDEST_FIRST}
        LIMIT ?`,
      [targetGroupCode, afterSeq, BigInt(limit)],
    );
    return rows.map(rowToGroupMsg);
  }

  /**
   * Batch-read messages oldest-first, starting from `afterSeq` (0n to begin).
   * Optionally filters by sendTime range (unix seconds). Use for analytics /
   * full-group scans that need to process every message in order.
   */
  async listBatch(
    targetGroupCode: string,
    afterSeq: bigint,
    limit = 500,
    startTime?: number,
    endTime?: number,
  ): Promise<GroupMsg[]> {
    const conditions: string[] = [`"40027" = ?`, `"40003" > ?`];
    const params: SqlValue[] = [targetGroupCode, afterSeq];
    if (startTime != null && startTime > 0) {
      conditions.push(`"40050" >= ?`);
      params.push(BigInt(startTime));
    }
    if (endTime != null && endTime > 0) {
      conditions.push(`"40050" <= ?`);
      params.push(BigInt(endTime));
    }
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE ${conditions.join(' AND ')}
        ${ORDER_OLDEST_FIRST}
        LIMIT ?`,
      [...params, BigInt(limit)],
    );
    return rows.map(rowToGroupMsg);
  }

  /**
   * The page of **seq-less** messages (40003 = 0 / NULL) just newer than
   * `afterRowId` (exclusive), ordered by rowid ASC. Export-only: migration-
   * imported history lands with no per-group seq, so the normal `40003 > ?`
   * cursor never sees it. Those rows keep a real sendTime, so the export merges
   * this rowid-ordered stream (insertion order ≈ send-time order for an imported
   * block) against the seq stream by sendTime — see `message_source`. Restricting
   * to seq-less rows keeps the two streams disjoint (no dupes).
   */
  async listSeqlessAfterRowId(
    targetGroupCode: string,
    afterRowId: bigint,
    limit = 50,
  ): Promise<Array<GroupMsg & { rowId: bigint }>> {
    const rows = await this.qq.query(
      `SELECT rowid, ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40027" = ? AND rowid > ? AND ("40003" = 0 OR "40003" IS NULL)
        ORDER BY rowid ASC
        LIMIT ?`,
      [targetGroupCode, afterRowId, BigInt(limit)],
    );
    return rows.map(rowToGroupMsgWithRowId);
  }

  /**
   * Messages with seq >= `sinceSeq`, newest-first, capped at `limit`. The
   * "re-read the currently-loaded window" query — picks up new tail messages
   * plus in-place edits (recall / sticker reactions) within the window.
   */
  async listFrom(targetGroupCode: string, sinceSeq: bigint, limit = 500): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40027" = ? AND "40003" >= ?
        ${ORDER_NEWEST_FIRST}
        LIMIT ?`,
      [targetGroupCode, sinceSeq, BigInt(limit)],
    );
    return rows.map(rowToGroupMsg);
  }

  /** Most recent N messages across all groups, newest first. Useful for "test dump". */
  async listRecent(limit = 50, offset = 0): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        ORDER BY "40001" DESC
        LIMIT ? OFFSET ?`,
      [BigInt(limit), BigInt(offset)],
    );
    return rows.map(rowToGroupMsg);
  }

  /**
   * The conversation's seq window for a time range (40003 > 0), newest-first.
   * Powers the export 「消息补全」seq 空窗扫描.
   *
   * No time bounds keeps the original index-only DISTINCT scan over the
   * `(40027,40003)` composite index. With `startTime`/`endTime` (unix seconds)
   * it reads each row's 40050 once and returns only the seqs inside the
   * window, plus the boundary anchors `below` (newest seq older than
   * `startTime`) and `above` (oldest seq newer than `endTime`) — the caller
   * clamps its bottom gap with them so a narrow window doesn't pull the whole
   * pre-window history.
   */
  async listSeqDesc(
    targetGroupCode: string,
    opts: { startTime?: number; endTime?: number } = {},
  ): Promise<SeqWindow> {
    const { startTime, endTime } = opts;
    if (startTime == null && endTime == null) {
      const rows = await this.qq.query(
        `SELECT DISTINCT "40003" FROM group_msg_table
          WHERE "40027" = ? AND "40003" > 0
          ORDER BY "40003" DESC`,
        [targetGroupCode],
      );
      return { seqs: rows.map((row) => toBigint(row[0])), below: null, above: null };
    }
    const rows = await this.qq.query(
      `SELECT "40003", "40050" FROM group_msg_table
        WHERE "40027" = ? AND "40003" > 0
        ORDER BY "40003" DESC`,
      [targetGroupCode],
    );
    const seqs: bigint[] = [];
    let below: bigint | null = null;
    let above: bigint | null = null;
    for (const row of rows) {
      const seq = toBigint(row[0]);
      const time = Number(row[1]);
      if (startTime != null && time < startTime) {
        below ??= seq; // 新→旧扫描：首个（最新）早于窗的消息即 below。
        continue;
      }
      if (endTime != null && time > endTime) {
        above = seq; // 覆盖式赋值：最后一个（最旧）晚于窗的消息即 above。
        continue;
      }
      seqs.push(seq);
    }
    return { seqs, below, above };
  }

  /** Largest SQLite rowid currently in the table, or 0n if empty. */
  async latestRowId(): Promise<bigint> {
    const rows = await this.qq.query(`SELECT MAX(rowid) FROM group_msg_table`);
    return toBigint(rows[0]?.[0]);
  }

  /**
   * Rows inserted after `sinceRowId` (rowid strictly greater), oldest-first.
   * rowid is monotonic on insert, so this reliably finds newly-arrived group
   * messages even when their msgId sorts below an older gray-tip's msgId —
   * the basis of the new-message notification signal.
   */
  async listSinceRowId(sinceRowId: bigint, limit = 500): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE rowid > ?
        ORDER BY rowid ASC
        LIMIT ?`,
      [sinceRowId, BigInt(limit)],
    );
    return rows.map(rowToGroupMsg);
  }

  /** Get raw msgBody (column 40800) by msgId. */
  async getMsgBody(msgId: bigint): Promise<Uint8Array | null> {
    const rows = await this.qq.query(
      `SELECT "40800" FROM group_msg_table WHERE "40001" = ? LIMIT 1`,
      [msgId],
    );
    return (rows[0]?.[0] as Uint8Array) ?? null;
  }

  /** Get raw decoration blob (column 40801) by msgId. */
  async getMsgDressBlob(msgId: bigint): Promise<Uint8Array | null> {
    const rows = await this.qq.query(
      `SELECT "40801" FROM group_msg_table WHERE "40001" = ? LIMIT 1`,
      [msgId],
    );
    return (rows[0]?.[0] as Uint8Array) ?? null;
  }

  /**
   * Update the msgBody (column 40800) for a specific message.
   *
   * Also bumps 40002 (msgRandom) in the same UPDATE — the anti-recall trigger's
   * "it's me, allow it" signal. See {@link C2cMsgDb.updateMsgBody} for the full
   * rationale (QQ recall keeps 40002; our edits change it, so the trigger only
   * catches recall).
   */
  async updateMsgBody(msgId: bigint, blob: Uint8Array): Promise<number> {
    const newRandom = BigInt(Math.floor(Math.random() * 0x7fffffff));
    return this.qq.write(`UPDATE group_msg_table SET "40800" = ?, "40002" = ? WHERE "40001" = ?`, [
      blob,
      newRandom,
      msgId,
    ]);
  }

  /**
   * Read a message's type columns (40011 msgType / 40012 subType) by msgId, or
   * null if this table doesn't hold it. These are what QQ itself rewrites to
   * `(1,1)` when a message is recalled/deleted; WeQ's delete mirrors that (see
   * {@link writeMsgType}) and remembers the originals to restore them.
   */
  async readMsgType(msgId: bigint): Promise<{ msgType: bigint; subType: bigint } | null> {
    const rows = await this.qq.query(
      `SELECT "40011","40012" FROM group_msg_table WHERE "40001" = ? LIMIT 1`,
      [msgId],
    );
    const row = rows[0];
    if (!row) return null;
    return { msgType: toBigint(row[0]), subType: toBigint(row[1]) };
  }

  /**
   * Overwrite a message's type columns (40011/40012) in place. Delete writes
   * `(1,1)` — byte-identical to QQ's own recall — leaving the 40800 body intact
   * so the message still renders; restore writes the remembered originals back.
   */
  async writeMsgType(msgId: bigint, msgType: bigint, subType: bigint): Promise<number> {
    return this.qq.write(`UPDATE group_msg_table SET "40011" = ?, "40012" = ? WHERE "40001" = ?`, [
      msgType,
      subType,
      msgId,
    ]);
  }

  /**
   * Fetch full message rows by msgId (40001), newest-first. Used to render the
   * "deleted messages" list: WeQ's delete leaves rows in their normal partition
   * (only 40011/40012 change), so the deleted set is addressed by msgId, not a
   * hidden partition key. Empty input short-circuits to [].
   */
  async listByMsgIds(msgIds: bigint[]): Promise<GroupMsg[]> {
    if (msgIds.length === 0) return [];
    const placeholders = msgIds.map(() => '?').join(',');
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40001" IN (${placeholders})
        ${ORDER_NEWEST_FIRST}`,
      msgIds,
    );
    return rows.map(rowToGroupMsg);
  }

  /**
   * Fetch full rows by msgSeq (40003) within ONE group (40027 = group code),
   * so the query hits the (40027,40003) composite index. Used to resolve FTS
   * search hits back to their original 40800 bodies: the FTS rows carry the
   * same 40027 partition + 40003 seq, so the join never leaves the partition.
   * Empty input short-circuits to [].
   */
  async listBySeqsInPartition(targetGroupCode: string, seqs: bigint[]): Promise<GroupMsg[]> {
    if (seqs.length === 0) return [];
    const placeholders = seqs.map(() => '?').join(',');
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40027" = ? AND "40003" IN (${placeholders})
        ${ORDER_NEWEST_FIRST}`,
      [targetGroupCode, ...seqs],
    );
    return rows.map(rowToGroupMsg);
  }

  /**
   * All rows in one group carrying the `(1,1)` deleted signature (40011=1 &
   * 40012=1), newest-first. Covers BOTH WeQ's own deletes and QQ's native
   * recalls — the caller splits them by consulting the DeletedMsgStore. This is
   * what lets the "deleted messages" panel surface QQ recalls the store never
   * recorded. `limit` bounds a pathologically recall-heavy group.
   */
  async listDeletedByConv(targetGroupCode: string, limit = 200): Promise<GroupMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_msg_table
        WHERE "40027" = ? AND "40011" = 1 AND "40012" = 1
        ${ORDER_NEWEST_FIRST}
        LIMIT ?`,
      [targetGroupCode, BigInt(limit)],
    );
    return rows.map(rowToGroupMsg);
  }

  /**
   * Append a new group message by cloning the group's newest row as a template
   * (see {@link appendClonedRow}). Returns the new msgId/msgSeq, or null if the
   * group has no message to clone.
   */
  async appendMessage(
    targetGroupCode: string,
    fields: AppendMsgFields,
  ): Promise<AppendMsgResult | null> {
    return appendClonedRow(this.qq, 'group_msg_table', '"40027" = ?', targetGroupCode, fields);
  }

  /**
   * Oldest sendTime (column 40050, unix seconds) in the whole table, or null
   * when empty. Unindexed — a single-pass MIN scan; used once per report open
   * to derive the first available year, then cached by the caller.
   */
  async oldestSendTime(): Promise<bigint | null> {
    const rows = await this.qq.query(`SELECT MIN("40050") FROM group_msg_table WHERE "40050" > 0`);
    const value = rows[0]?.[0];
    return value == null ? null : toBigint(value);
  }

  /**
   * The distinct local-time years in which the table holds at least one
   * message. Deliberately does NOT filter by sender/own marker: this is the
   * cheap year-eligibility probe for the report entry page, and it runs on the
   * day-midnight column 40058, which is covered by the `(40027,40058)` index —
   * SQLite resolves it as a covering index scan without touching message rows.
   * Rows with a 0 / NULL day timestamp (malformed or system rows) are skipped
   * with `"40058" > 0`.
   *
   * The year is derived with `'localtime'` so buckets line up with the
   * report's local-midnight year boundaries.
   */
  async yearsWithMessages(): Promise<number[]> {
    const rows = await this.qq.query(
      `SELECT DISTINCT CAST(strftime('%Y',"40058",'unixepoch','localtime') AS INTEGER) AS y
       FROM group_msg_table
       WHERE "40058" > 0`,
    );
    return rows.map((row) => Number(row[0] ?? 0)).filter((year) => year > 0);
  }

  /**
   * 一个时间窗内**自己发出的**群聊按「星期 × 本地小时」聚合，返回 7×24 矩阵。
   *
   * 自证 marker 用 senderUid 优先、selfUin 兜底；两者都没有时返回全零矩阵 ——
   * 分不清哪些群消息是自己的时候，全群算给自己会把别人的作息也算进来。
   * 小时/星期用 `'localtime'` 与报告口径对齐。
   */
  async sentWeekdayHourlyTallies(
    opts: { startTime?: number; endTime?: number; selfUin?: bigint; senderUid?: string } = {},
  ): Promise<SentWeekdayHourlyGrid> {
    const mine = opts.senderUid
      ? { clause: `"40020" = ? AND "40020" != ''`, value: opts.senderUid as SqlValue }
      : opts.selfUin !== undefined && opts.selfUin > 0n
        ? { clause: `"40033" = ?`, value: opts.selfUin as SqlValue }
        : null;
    if (!mine) return buildWeekdayHourlyGrid([]);

    const conditions: string[] = [`"40050" > 0`, mine.clause];
    const params: SqlValue[] = [mine.value];
    if (opts.startTime != null && opts.startTime > 0) {
      conditions.push(`"40050" >= ?`);
      params.push(BigInt(opts.startTime));
    }
    if (opts.endTime != null && opts.endTime > 0) {
      conditions.push(`"40050" < ?`);
      params.push(BigInt(opts.endTime));
    }
    const rows = await this.qq.query(
      `SELECT CAST(strftime('%w',"40050",'unixepoch','localtime') AS INTEGER) AS dow,
              CAST(strftime('%H',"40050",'unixepoch','localtime') AS INTEGER) AS hour,
              COUNT(*) AS n
       FROM group_msg_table
       WHERE ${conditions.join(' AND ')}
       GROUP BY dow, hour`,
      params,
    );
    return buildWeekdayHourlyGrid(rows);
  }

  /**
   * 自己发出的群聊消息，逐条解码正文 —— 年度报告「我的话」页的原始素材。
   *
   * 自证 marker 用 senderUid 优先、selfUin 兜底；两者都没有时返回空数组，
   * 不把别人的群发言算给自己。窗口时间用调用方给的 unix 秒半开区间；
   * 空 body 的行在 SQL 侧滤掉。
   *
   * 返回的是**共享只读**数组（调用方只在 compute 内聚合，不得修改）。
   */
  async sentSpeechRows(
    opts: { startTime?: number; endTime?: number; selfUin?: bigint; senderUid?: string } = {},
  ): Promise<SentSpeechRow[]> {
    const mine = opts.senderUid
      ? { clause: `"40020" = ? AND "40020" != ''`, value: opts.senderUid as SqlValue }
      : opts.selfUin !== undefined && opts.selfUin > 0n
        ? { clause: `"40033" = ?`, value: opts.selfUin as SqlValue }
        : null;
    if (!mine) return [];

    const conditions: string[] = [`"40050" > 0`, mine.clause, `length("40800") > 0`];
    const params: SqlValue[] = [mine.value];
    if (opts.startTime != null && opts.startTime > 0) {
      conditions.push(`"40050" >= ?`);
      params.push(BigInt(opts.startTime));
    }
    if (opts.endTime != null && opts.endTime > 0) {
      conditions.push(`"40050" < ?`);
      params.push(BigInt(opts.endTime));
    }
    const rows = await this.qq.query(
      `SELECT "40050","40800" FROM group_msg_table WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return rows.map((row) => ({
      sendTime: toBigint(row[0]),
      elements: decodeBody(row[1]),
    }));
  }

  /**
   * 某一个群的**全体成员**在时间窗内发出的正文行 —— 年度报告「我的主场」页
   * 给冠军群数词云用。与 {@link sentSpeechRows} 不同，这一页要的是「大家聊了
   * 什么」，所以不按 sender 过滤，只锁群号与时间窗；空 body 的行在 SQL 侧滤掉。
   *
   * 窗口与报告口径一致：unix 秒半开区间 [startTime, endTime)。返回的是**共享
   * 只读**数组（调用方只在 compute 内聚合，不得修改）。
   */
  async bodyRowsInGroup(
    targetGroupCode: string,
    opts: { startTime?: number; endTime?: number } = {},
  ): Promise<SentSpeechRow[]> {
    const conditions: string[] = [`"40027" = ?`, `"40050" > 0`, `length("40800") > 0`];
    const params: SqlValue[] = [targetGroupCode];
    if (opts.startTime != null && opts.startTime > 0) {
      conditions.push(`"40050" >= ?`);
      params.push(BigInt(opts.startTime));
    }
    if (opts.endTime != null && opts.endTime > 0) {
      conditions.push(`"40050" < ?`);
      params.push(BigInt(opts.endTime));
    }
    const rows = await this.qq.query(
      `SELECT "40050","40800" FROM group_msg_table WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return rows.map((row) => ({
      sendTime: toBigint(row[0]),
      elements: decodeBody(row[1]),
    }));
  }

  /**
   * 群聊互动的年度聚合：我自己发起的戳一戳与 @、别人直接 @ 到我的群分布、
   * 以及全群的「复读」回合（连续相同正文 >3 条，且至少两个人）。一次性全量
   * 扫描时间窗内的消息正文 —— 这是年度报告里最重的页面之一，页面排得靠后，
   * 由调用方决定何时计算。
   *
   * 扫法：先按时间窗取一次 DISTINCT 群号，再**逐群**把该窗正文行取出解码并
   * 当场聚合。绝不把所有群的整年消息同时装进内存 —— 任一时刻只有当前群的一
   * 份行数组和一份聚合。聚合结果只留冠军，不把整年长尾送回去。
   *
   * 复读口径：以「消息可见文本」为签名（text + at 元素拼接），同一群内按
   * `40003 / 40050 / 40001` 时间序连续相同签名、长度 >3 且至少两个发言者才
   * 算一个回合。中途插一条不同正文会断掉当前回合，媒体 / 灰条等无正文行不
   * 参与比较（它们不打断）。
   */
  async tallyInteractions(
    opts: { startTime?: number; endTime?: number; senderUid?: string; selfUin?: bigint } = {},
  ): Promise<GroupInteractionTally> {
    const selfUid = String(opts.senderUid ?? '').trim();
    const selfUin = opts.selfUin !== undefined && opts.selfUin > 0n ? opts.selfUin : 0n;

    const pokeTargets = new Map<string, PersonAgg>();
    const atTargets = new Map<string, PersonAgg>();
    const atMeGroups = new Map<string, number>();
    let pokeTotal = 0;
    let atTotal = 0;
    const echo = {
      participatedRuns: 0,
      longest: null as GroupEchoLongest | null,
    };

    const codes = await this.interactionGroupCodes(opts);
    for (const groupCode of codes) {
      const conditions: string[] = [`"40027" = ?`, `"40050" > 0`, `length("40800") > 0`];
      const params: SqlValue[] = [groupCode];
      this.appendTimeWindow(conditions, params, opts);

      const rows = await this.qq.query(
        `SELECT "40001","40003","40020","40033","40050","40800"
         FROM group_msg_table
         WHERE ${conditions.join(' AND ')}
         ORDER BY "40003" ASC, "40050" ASC, "40001" ASC`,
        params,
      );

      let current: EchoRun | null = null;
      const finalize = (): void => {
        if (!current || current.count < ECHO_AT_LEAST_COUNT) return;
        if (current.participants.size < 2) return;
        if (current.mine) echo.participatedRuns += 1;
        if (
          !echo.longest ||
          current.count > echo.longest.count ||
          (current.count === echo.longest.count &&
            `${groupCode}:${current.sig}` < `${echo.longest.groupCode}:${echo.longest.text}`)
        ) {
          echo.longest = {
            groupCode,
            count: current.count,
            text: current.sig.slice(0, ECHO_TEXT_KEEP),
          };
        }
      };

      for (const row of rows) {
        const senderUid = toStr(row[2]);
        const senderUin = toBigint(row[3]);
        const mine =
          (selfUid !== '' && senderUid === selfUid) ||
          (selfUin > 0n && senderUin === selfUin && (selfUid === '' || senderUid === ''));
        const elements = decodeBody(row[5]);

        for (const element of elements) {
          if (element.kind === 'grayTipPoke') {
            const poke = element as GrayTipPokeElement;
            if (poke.detailedId !== POKE_DETAILED_ID) continue;
            const parties = pokeParties(poke);
            if (parties.initiatorUid === selfUid || parties.initiatorUin === String(selfUin)) {
              pokeTotal += 1;
              if (parties.targetUid === '' && parties.targetUin === '') continue;
              bumpTarget(pokeTargets, {
                groupCode,
                targetUid: parties.targetUid,
                targetUin: parties.targetUin,
                name: parties.targetName,
              });
            }
            continue;
          }
          if (element.kind !== 'at') continue;

          const at = element as AtElement;
          const targetUid = String(at.atTargetUid ?? '');
          const targetUin = numStr(at.textEncodingFlag);
          const name = String(at.textContent ?? '')
            .replace(/^@/, '')
            .trim();

          if (mine && isPersonMention(at)) {
            if (selfUid !== '' && targetUid === selfUid) continue; // 自己 @ 自己不算
            if (selfUid === '' && targetUin !== '' && Number(targetUin) === Number(selfUin)) {
              continue;
            }
            atTotal += 1;
            bumpTarget(atTargets, {
              groupCode,
              targetUid,
              targetUin,
              name,
            });
            continue;
          }

          // 别人直接 @ 到我：uid 精确匹配；老库只有 uin 时用 textEncodingFlag 兜底。
          const hitMe =
            (selfUid !== '' && targetUid !== '' && targetUid === selfUid) ||
            (selfUid === '' &&
              selfUin > 0n &&
              targetUin !== '' &&
              Number(targetUin) === Number(selfUin));
          if (!mine && hitMe && isPersonMention(at)) {
            atMeGroups.set(groupCode, (atMeGroups.get(groupCode) ?? 0) + 1);
          }
        }

        // 复读：只看「人说过的话」。正文在无正文行里为空，连续比较自动跨过去。
        const sig = visibleText(elements);
        if (!sig) continue;
        const participant = senderUid || (senderUin > 0n ? `uin:${senderUin}` : '');
        if (current && current.sig === sig) {
          current.count += 1;
          current.participants.add(participant);
          if (mine) current.mine = true;
          continue;
        }
        finalize();
        current = {
          sig,
          count: 1,
          participants: new Set([participant]),
          mine,
        };
      }
      finalize();
    }

    return {
      poke: {
        total: pokeTotal,
        top: pickTargetTop(pokeTargets),
      },
      at: {
        total: atTotal,
        top: pickTargetTop(atTargets),
      },
      atMe: {
        total: [...atMeGroups.values()].reduce((sum, count) => sum + count, 0),
        topGroup: pickAtMeTop(atMeGroups),
      },
      echo,
    };
  }

  /** 时间窗内的非空群号（去重、排序稳定）。 */
  private async interactionGroupCodes(opts: {
    startTime?: number;
    endTime?: number;
  }): Promise<string[]> {
    const conditions: string[] = [
      `"40050" > 0`,
      `"40027" IS NOT NULL AND "40027" != ''`,
      `length("40800") > 0`,
    ];
    const params: SqlValue[] = [];
    this.appendTimeWindow(conditions, params, opts);
    const rows = await this.qq.query(
      `SELECT DISTINCT "40027" FROM group_msg_table WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return rows
      .map((row) => toStr(row[0]))
      .filter((code) => code !== '')
      .sort((a, b) => a.localeCompare(b, 'en'));
  }

  /** 半开时间窗 [start, end)，0/缺省表示不设这一侧。 */
  private appendTimeWindow(
    conditions: string[],
    params: SqlValue[],
    opts: { startTime?: number; endTime?: number },
  ): void {
    if (opts.startTime != null && opts.startTime > 0) {
      conditions.push(`"40050" >= ?`);
      params.push(BigInt(opts.startTime));
    }
    if (opts.endTime != null && opts.endTime > 0) {
      conditions.push(`"40050" < ?`);
      params.push(BigInt(opts.endTime));
    }
  }

  /**
   * Split the whole table's rows in a time window into sent / received, in ONE
   * pass. Sent means QQ's own 40040 marker = 1 (locally originated by this
   * account), which excludes self-forwarded copies of other people's messages
   * even though their senderUid is ours. No account identity is needed any
   * more. Everything else — other members' rows and sync copies alike — is
   * counted as received. This is the cheapest shape (one scan, no body
   * decode).
   */
  async countByDirection(
    opts: { startTime?: number; endTime?: number } = {},
  ): Promise<{ sent: number; received: number }> {
    const conditions: string[] = [];
    const whereParams: SqlValue[] = [];
    if (opts.startTime != null && opts.startTime > 0) {
      conditions.push(`"40050" >= ?`);
      whereParams.push(BigInt(opts.startTime));
    }
    if (opts.endTime != null && opts.endTime > 0) {
      conditions.push(`"40050" < ?`);
      whereParams.push(BigInt(opts.endTime));
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = await this.qq.query(
      `SELECT "40040" AS mine, COUNT(*) AS n
       FROM group_msg_table${where}
       GROUP BY 1`,
      whereParams,
    );
    let sent = 0;
    let received = 0;
    for (const row of rows) {
      const mine = Number(row[0] ?? 0);
      const n = Number(row[1] ?? 0);
      if (mine === 1) sent = n;
      else received = n;
    }
    return { sent, received };
  }

  /**
   * 时间窗内按群拆分「我发的 / 全群总消息」—— 年度报告「我的主场」页的排行素材。
   *
   * 与 {@link countByDirection} 同一套自证 marker（senderUid 优先、selfUin
   * 兜底）；一次 `GROUP BY 群号, 方向` 的扫描只数几列元数据，不碰 40800 正文。
   * 窗口是报告口径的半开区间 [startTime, endTime) —— 区别于周报用的
   * {@link countByGroups}（≤ 闭区间），避免把次年初那一秒算进今年。
   *
   * ⚠️ `?` 是**位置绑定**：mine marker 参数在 SELECT 里，必须排在 WHERE 组号
   *    参数之前，不能追加在后面。
   */
  async countByGroupAndDirection(
    groupCodes: string[],
    opts: { startTime?: number; endTime?: number; senderUid?: string; selfUin?: bigint } = {},
  ): Promise<Array<{ groupCode: string; sent: number; total: number }>> {
    if (groupCodes.length === 0) return [];
    const mineExpr = opts.senderUid
      ? `CASE WHEN "40020" = ? AND "40020" != '' THEN 1 ELSE 0 END`
      : opts.selfUin !== undefined && opts.selfUin > 0n
        ? `CASE WHEN "40033" = ? THEN 1 ELSE 0 END`
        : null;
    if (!mineExpr) {
      return groupCodes.map((code) => ({ groupCode: code, sent: 0, total: 0 }));
    }

    const placeholders = groupCodes.map(() => '?').join(',');
    const conditions: string[] = [`"40027" IN (${placeholders})`];
    const whereParams: SqlValue[] = [...groupCodes];
    if (opts.startTime != null && opts.startTime > 0) {
      conditions.push(`"40050" >= ?`);
      whereParams.push(BigInt(opts.startTime));
    }
    if (opts.endTime != null && opts.endTime > 0) {
      conditions.push(`"40050" < ?`);
      whereParams.push(BigInt(opts.endTime));
    }
    const mineParam: SqlValue = opts.senderUid ?? (opts.selfUin !== undefined ? opts.selfUin : 0n);
    const rows = await this.qq.query(
      `SELECT "40027", ${mineExpr} AS mine, COUNT(*) AS n
       FROM group_msg_table
       WHERE ${conditions.join(' AND ')}
       GROUP BY 1, 2`,
      [mineParam, ...whereParams],
    );

    const tally = new Map<string, { sent: number; total: number }>();
    for (const code of groupCodes) tally.set(code, { sent: 0, total: 0 });
    for (const row of rows) {
      const code = String(row[0] ?? '');
      const mine = Number(row[1] ?? 0);
      const n = Number(row[2] ?? 0);
      const bucket = tally.get(code);
      if (!bucket) continue;
      bucket.total += n;
      if (mine === 1) bucket.sent += n;
    }
    return [...tally.entries()].map(([groupCode, bucket]) => ({
      groupCode,
      sent: bucket.sent,
      total: bucket.total,
    }));
  }

  /**
   * 统计**我发出的**群消息里各套装扮各用了多少条（列 40801），顺带采样正文。与
   * {@link C2cMsgDb.tallyDress} 同形，只是「我」的判据换成群聊那一套：`senderUid`
   * （40020）优先，没有时退到 `selfUin`（40033）。两个都没有就返回空 tally ——
   * 分不清谁发的时候，把全群的装扮算成自己的会比不算更糟。
   */
  async tallyDress(
    opts: { startTime?: number; endTime?: number; selfUin?: bigint; senderUid?: string } = {},
  ): Promise<DressTally> {
    const mine = opts.senderUid
      ? { clause: `"40020" = ? AND "40020" != ''`, value: opts.senderUid as SqlValue }
      : opts.selfUin !== undefined && opts.selfUin > 0n
        ? { clause: `"40033" = ?`, value: opts.selfUin as SqlValue }
        : null;
    if (!mine) return emptyDressTally();

    const conditions = [mine.clause, `length("40801") > 0`];
    const params: SqlValue[] = [mine.value];
    if (opts.startTime != null && opts.startTime > 0) {
      conditions.push(`"40050" >= ?`);
      params.push(BigInt(opts.startTime));
    }
    if (opts.endTime != null && opts.endTime > 0) {
      conditions.push(`"40050" < ?`);
      params.push(BigInt(opts.endTime));
    }
    const rows = await this.qq.query(
      `SELECT "40801","40800","40050" FROM group_msg_table WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return tallyDressBlobs(rows, emptyDressTally());
  }

  /**
   * Batch count messages per group. Returns { groupCode: count }.
   *
   * `opts` adds extra `AND`s onto the same indexed `40027 IN (…)` scan:
   *   - `startTime`/`endTime` (unix seconds) → window on `40050` sendTime;
   *   - `senderUid` → count only messages *this* uid sent (e.g. self, to rank
   *     「我在哪个群最活跃」 rather than the group's total traffic).
   */
  async countByGroups(
    groupCodes: string[],
    opts: { startTime?: number; endTime?: number; senderUid?: string } = {},
  ): Promise<Record<string, number>> {
    if (groupCodes.length === 0) return {};
    const placeholders = groupCodes.map(() => '?').join(',');
    const conditions = [`"40027" IN (${placeholders})`];
    const params: SqlValue[] = [...groupCodes];
    if (opts.startTime != null && opts.startTime > 0) {
      conditions.push(`"40050" >= ?`);
      params.push(BigInt(opts.startTime));
    }
    if (opts.endTime != null && opts.endTime > 0) {
      conditions.push(`"40050" <= ?`);
      params.push(BigInt(opts.endTime));
    }
    if (opts.senderUid) {
      conditions.push(`"40020" = ?`);
      params.push(opts.senderUid);
    }
    const rows = await this.qq.query(
      `SELECT "40027", COUNT(*) FROM group_msg_table WHERE ${conditions.join(' AND ')} GROUP BY "40027"`,
      params,
    );
    const result: Record<string, number> = {};
    for (const row of rows) {
      const code = String(row[0] ?? '');
      const count = typeof row[1] === 'bigint' ? Number(row[1]) : Number(row[1] ?? 0);
      if (code) result[code] = count;
    }
    return result;
  }

  /** Drop the cached native connection. Call on account switch / shutdown. */
  close(): void {
    this.qq.close();
  }
}

function rowToGroupMsg(row: SqlRow): GroupMsg {
  return {
    msgId: toBigint(row[0]),
    senderUid: toStr(row[1]),
    targetGroupCode: toStr(row[2]),
    senderUin: toBigint(row[3]),
    sendTime: toBigint(row[4]),
    elements: decodeBody(row[5]),
    setEmojiList: decodeEmoji(row[6]),
    msgSeq: toBigint(row[7]),
    msgType: toBigint(row[8]),
    subType: toBigint(row[9]),
    decoration: decodeDress(row[10]),
  };
}

/** As {@link rowToGroupMsg} but for a `SELECT rowid, …` row (indices shifted +1). */
function rowToGroupMsgWithRowId(row: SqlRow): GroupMsg & { rowId: bigint } {
  return {
    rowId: toBigint(row[0]),
    msgId: toBigint(row[1]),
    senderUid: toStr(row[2]),
    targetGroupCode: toStr(row[3]),
    senderUin: toBigint(row[4]),
    sendTime: toBigint(row[5]),
    elements: decodeBody(row[6]),
    setEmojiList: decodeEmoji(row[7]),
    msgSeq: toBigint(row[8]),
    msgType: toBigint(row[9]),
    subType: toBigint(row[10]),
    decoration: decodeDress(row[11]),
  };
}

/** 复读回合最少条数：用户口径「重复超过 3 次」，即第 4 条起算。 */
const ECHO_AT_LEAST_COUNT = 4;
/** QQ nudge（戳一戳）灰条的 detailedId。 */
const POKE_DETAILED_ID = 1061;
/** 页面展示的复读正文最长保留长度；匹配签名始终用完整正文，只在落盘时截断。 */
const ECHO_TEXT_KEEP = 72;

/** 一个复读目标的滚动聚合（只用于 db 方法内部，最后只吐冠军）。 */
type PersonAgg = {
  targetUid: string;
  targetUin: string;
  total: number;
  /** 每个群里的次数：解析群名片时挑最大的那个群。 */
  groups: Map<string, number>;
  /** 消息里自带的名字 → 出现次数。 */
  names: Map<string, number>;
};

/** 当前正在观察的一轮复读。 */
type EchoRun = {
  sig: string;
  count: number;
  participants: Set<string>;
  mine: boolean;
};

/** 可显示的正文签名：text + at 拼接，压空白。媒体等元素不参与。 */
function visibleText(elements: Element[]): string {
  let text = '';
  for (const element of elements) {
    if (element.kind === 'text' || element.kind === 'at') {
      text += element.textContent ?? '';
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** @全体不入“点名”账：内容带「全体」或带 atMentionMask 的都跳过。 */
function isPersonMention(at: AtElement): boolean {
  if (String(at.atMentionMask ?? '') !== '') return false;
  return !/全体|all/i.test(String(at.textContent ?? ''));
}

/** 灰条里戳一戳的双方。actionTarget 只在部分版本有，其余从 XML/tipJson 补。 */
function pokeParties(poke: GrayTipPokeElement): {
  initiatorUid: string;
  initiatorUin: string;
  targetUid: string;
  targetUin: string;
  targetName: string;
} {
  const attrs = new Map<string, string>();
  for (const item of poke.actionAttributes ?? []) {
    const key = String(item.key ?? '').trim();
    if (key) attrs.set(key, String(item.value ?? '').trim());
  }
  const attr = (key: string): string => attrs.get(key) ?? '';

  const xmlPeople: string[] = [];
  const xmlRe = /<qq\s[^>]*\buin\s*=\s*["']([^"']*)["']/gi;
  for (const match of String(poke.grayTipXmlContent ?? '').matchAll(xmlRe)) {
    const value = String(match[1] ?? '').trim();
    if (value) xmlPeople.push(value);
  }

  let jsonPeople: Array<{ uid?: string; uin?: string; nm?: string }> = [];
  try {
    const parsed = JSON.parse(poke.tipJson ?? '') as {
      items?: Array<{ type?: string; uid?: string; uin?: string; nm?: string }>;
    };
    jsonPeople = (parsed.items ?? []).filter((item) => item.type === 'qq' || item.type === 'url');
  } catch {
    jsonPeople = [];
  }

  const initiatorUid =
    poke.actionInitiator?.uid?.trim() ?? xmlPeople[1] ?? jsonPeople[1]?.uid ?? '';
  const targetUid = poke.actionTarget?.uid?.trim() ?? xmlPeople[0] ?? jsonPeople[0]?.uid ?? '';
  const targetUin = /^\d+$/.test(attr('uin_str1')) ? attr('uin_str1') : '';
  const initiatorUin = /^\d+$/.test(attr('uin_str2')) ? attr('uin_str2') : '';
  const targetName =
    poke.actionTarget?.nickname?.trim() || attr('nick_str1') || jsonPeople[0]?.nm?.trim() || '';

  return {
    initiatorUid: String(initiatorUid ?? ''),
    initiatorUin,
    targetUid: String(targetUid ?? ''),
    targetUin,
    targetName,
  };
}

/** 一个数字/字符串值转十进制字符串；空值返回 ''。 */
function numStr(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return '';
  try {
    const n = BigInt(text);
    return n > 0n ? String(n) : '';
  } catch {
    return '';
  }
}

/** 给「戳/at 目标」加一票，并记录群与消息内名字。 */
function bumpTarget(
  map: Map<string, PersonAgg>,
  input: {
    groupCode: string;
    targetUid: string;
    targetUin: string;
    name: string;
  },
): void {
  const { groupCode, targetUid, targetUin, name } = input;
  if (targetUid === '' && targetUin === '') return;
  const key = targetUid || `uin:${targetUin}`;
  let agg = map.get(key);
  if (!agg) {
    agg = {
      targetUid,
      targetUin,
      total: 0,
      groups: new Map(),
      names: new Map(),
    };
    map.set(key, agg);
  }
  agg.total += 1;
  agg.groups.set(groupCode, (agg.groups.get(groupCode) ?? 0) + 1);
  const cleanName = name.replace(/\s+/g, ' ').trim();
  if (cleanName) {
    agg.names.set(cleanName, (agg.names.get(cleanName) ?? 0) + 1);
  }
}

/** 聚合里挑总次数第一；次数相同的比 key 字典序，结果可复现。 */
function pickTargetTop(map: Map<string, PersonAgg>): GroupTargetTop | null {
  let bestKey = '';
  let best: PersonAgg | null = null;
  for (const [key, agg] of map) {
    if (!best || agg.total > best.total || (agg.total === best.total && key < bestKey)) {
      best = agg;
      bestKey = key;
    }
  }
  if (!best) return null;

  let groupCode = '';
  let groupCount = 0;
  for (const [code, count] of best.groups) {
    if (count > groupCount || (count === groupCount && code < groupCode)) {
      groupCode = code;
      groupCount = count;
    }
  }

  let displayName = '';
  let nameCount = 0;
  for (const [name, count] of best.names) {
    if (count > nameCount || (count === nameCount && name < displayName)) {
      displayName = name;
      nameCount = count;
    }
  }

  return {
    targetUid: best.targetUid,
    targetUin: best.targetUin,
    groupCode,
    count: best.total,
    displayName,
  };
}

/** 被 @ 最多的群。 */
function pickAtMeTop(map: Map<string, number>): GroupAtMeTop | null {
  let top: GroupAtMeTop | null = null;
  for (const [groupCode, count] of map) {
    if (!top || count > top.count || (count === top.count && groupCode < top.groupCode)) {
      top = { groupCode, count };
    }
  }
  return top;
}
