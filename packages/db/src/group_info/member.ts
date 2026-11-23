/**
 * `group_member3` — Group membership records.
 *
 * Column map:
 *   64003  card            (TEXT) - Group-specific nickname
 *   20002  nick            (TEXT) - Global QQ nickname
 *   60001  groupCode       (INTEGER)
 *   1000   uid             (TEXT) - NT UID
 *   1002   uin             (INTEGER) - QQ Number
 *   64007  joinTime        (INTEGER)
 *   64008  lastSpeakTime   (INTEGER)
 *   64009  muteUntil       (INTEGER) - Last forbidden release timestamp
 *   64010  adminFlag       (INTEGER) - 0: member, 1: admin
 *   64015  field64015      (INTEGER)
 *   64016  memberFlag      (INTEGER) - 0 or NULL: active member, 1: left
 *   64023  customTitle     (TEXT) - Custom title/rank
 *   64035  memberLevel     (INTEGER)
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { createPinyinMatcher } from '@weq/codec/pinyin-search';
import { QqDb } from '../qq_db';
import { measureMessageWork, withDatabaseReadBudget } from '../query_schedule';

export interface GroupMember {
  groupCode: bigint;
  uid: string;
  uin: bigint;
  card: string;
  nick: string;
  joinTime: number;
  lastSpeakTime: number;
  muteUntil: number;
  adminFlag: number;
  memberFlag: number;
  customTitle: string;
  memberLevel: number;
}

/** One group-member search hit (across all groups). */
export interface GroupMemberSearchHit {
  /** Group code (60001) of the group the member was found in. */
  groupCode: string;
  uid: string;
  uin: string;
  nick: string;
  card: string;
}

export interface GroupMemberDbOptions {
  dbPath: string;
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

const MEMBER_COLUMNS = [
  '60001',
  '1000',
  '1002',
  '64003',
  '20002',
  '64007',
  '64008',
  '64009',
  '64010',
  '64016',
  '64023',
  '64035',
];
const MEMBERSHIP_GROUP_BATCH = 16;
type MembershipSnapshot = Map<string, { total: number; friends: Set<string> }>;
const ACTIVE_MEMBERSHIP = `("64016" = 0 OR "64016" IS NULL)`;
const MEMBERSHIP_SUMMARY_SQL = `SELECT "60001",
    COUNT(DISTINCT "1000" COLLATE BINARY) FILTER (WHERE ${ACTIVE_MEMBERSHIP}),
    json_group_array(DISTINCT "1000" COLLATE BINARY) FILTER (
      WHERE ${ACTIVE_MEMBERSHIP} AND "1000" COLLATE BINARY IN (SELECT value FROM json_each(?))
    ),
    COUNT(*) FILTER (WHERE typeof("64016") NOT IN ('integer', 'real', 'null'))
  FROM group_member3
  WHERE "60001" IN (SELECT value FROM json_each(?))
    AND typeof("1000") = 'text' AND "1000" GLOB 'u_?*'
    AND "1000" NOT GLOB '*[^A-Za-z0-9_-]*' AND instr("1000", char(0)) = 0
  GROUP BY "60001"`;
function membershipQueryTimedOut(error: unknown): boolean {
  return error instanceof Error && error.message.includes('database_query_execution_timeout');
}

export class GroupMemberDb {
  get dbPath(): string {
    return this.qq.dbPath;
  }
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: GroupMemberDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  private getColumns(): Promise<ReadonlySet<string>> {
    return this.qq.tableColumns('group_member3');
  }

  private async selectColumns(alias = 'group_member3'): Promise<string> {
    const columns = await this.getColumns();
    return MEMBER_COLUMNS.map((column) =>
      (column === '64023' || column === '64035') && !columns.has(column)
        ? 'NULL'
        : `${alias}."${column}"`,
    ).join(',');
  }

  private async levelColumn(): Promise<string> {
    return (await this.getColumns()).has('64035') ? '"64035"' : 'NULL';
  }

  /** 联系人校准只读取有效成员总数与好友交集，不加载昵称、等级等整份成员资料。 */
  async contactMembershipSnapshot(
    friendUids: string[],
    groupCodes?: readonly string[],
  ): Promise<MembershipSnapshot> {
    const groups = groupCodes ? new Set(groupCodes) : undefined;
    return measureMessageWork(this.dbPath, 'contactMembership', async () => {
      if (groups && !groups.size) return new Map();
      const friends = new Set(friendUids.filter(Boolean));
      if (groups && (await this.qq.hasLeadingIndex('group_member3', '60001')))
        return this.readIndexedMembershipSnapshot(friends, groups);
      return this.readContactMembershipSnapshot(friends, groups);
    });
  }

  private async readIndexedMembershipSnapshot(
    friends: ReadonlySet<string>,
    groups: ReadonlySet<string>,
  ): Promise<MembershipSnapshot> {
    const result: MembershipSnapshot = new Map();
    const fallback = new Set<string>();
    const codes = [...groups];
    const friendList = JSON.stringify([...friends]);
    let batchSize = MEMBERSHIP_GROUP_BATCH;
    for (let offset = 0; offset < codes.length; ) {
      const read = () =>
        this.qq.query(MEMBERSHIP_SUMMARY_SQL, [
          friendList,
          JSON.stringify(codes.slice(offset, offset + batchSize)),
        ]);
      let rows: SqlRow[];
      try {
        rows = await (this.qq.supportsReadBudget ? withDatabaseReadBudget(35, read) : read());
      } catch (error) {
        if (!membershipQueryTimedOut(error)) throw error;
        if (batchSize === 1) fallback.add(codes[offset++]!);
        else batchSize = Math.max(1, Math.floor(batchSize / 2));
        continue;
      }
      for (const [code, total, json, untyped] of rows) {
        const key = String(code);
        if (!groups.has(key)) continue;
        // 旧库异常字段交给原来的 Number 转换，保留其匹配语义。
        if (Number(untyped) > 0) fallback.add(key);
        else if (Number(total) > 0)
          result.set(key, {
            total: Number(total),
            friends: new Set<string>(JSON.parse(String(json))),
          });
      }
      offset += batchSize;
    }
    if (fallback.size)
      for (const [code, group] of await this.readContactMembershipSnapshot(friends, fallback))
        result.set(code, group);
    return result;
  }

  private async readContactMembershipSnapshot(
    friends: ReadonlySet<string>,
    selectedGroups?: ReadonlySet<string>,
  ): Promise<MembershipSnapshot> {
    const groups: MembershipSnapshot = new Map();
    const seen = new Map<string, Set<string>>();
    for await (const rows of this.qq.rowidPages(
      'group_member3',
      ['60001', '1000', '64016'],
      undefined,
      selectedGroups ? { column: '60001', values: [...selectedGroups] } : undefined,
    )) {
      for (const row of rows) {
        const code = String(row[1]);
        if (selectedGroups && !selectedGroups.has(code)) continue;
        const uid = row[2];
        if (
          (row[3] !== null && Number(row[3]) !== 0) ||
          typeof uid !== 'string' ||
          !/^u_[A-Za-z0-9_-]+$/.test(uid)
        )
          continue;
        let members = seen.get(code);
        if (!members) {
          members = new Set();
          seen.set(code, members);
          groups.set(code, { total: 0, friends: new Set() });
        }
        if (members.has(uid)) continue;
        members.add(uid);
        const group = groups.get(code)!;
        group.total++;
        if (friends.has(uid)) group.friends.add(uid);
      }
    }
    return groups;
  }

  /**
   * List all members of a specific group.
   * Filters by active members (64016 = 0) by default.
   */
  async listMembersInGroup(groupCode: bigint, limit = 100, offset = 0): Promise<GroupMember[]> {
    const rows = await this.qq.query(
      `SELECT ${await this.selectColumns('m')}
       FROM group_member3 m
       LEFT JOIN group_detail_info_ver1 d ON m."60001" = d."60001"
       WHERE m."60001" = ? AND ("64016" = 0 OR "64016" IS NULL)
       ORDER BY (m."1000" = d."60002") DESC, m."64010" DESC, m."64007" ASC
       LIMIT ? OFFSET ?`,
      [groupCode, limit, offset],
    );
    return rows.map(rowToMember);
  }

  /**
   * List a group's **已退群** members (64016 = 1), newest join first.
   *
   * QQ keeps the member row after someone leaves (only 64016 flips to 1), so
   * this is the opposite filter of {@link listMembersInGroup}. Rows with an
   * empty uid / uin are dropped here too — they can't be resolved to a person,
   * and would render as a blank row or a raw uid with no QQ number.
   */
  async listLeftMembersInGroup(groupCode: bigint, limit = 100, offset = 0): Promise<GroupMember[]> {
    const rows = await this.qq.query(
      `SELECT ${await this.selectColumns()} FROM group_member3
       WHERE "60001" = ? AND "64016" = 1
         AND "1000" IS NOT NULL AND "1000" <> ''
         AND "1002" IS NOT NULL AND "1002" <> 0
       ORDER BY "64007" DESC
       LIMIT ? OFFSET ?`,
      [groupCode, limit, offset],
    );
    return rows.map(rowToMember);
  }

  /**
   * List a group's members ordered by member level (高→低), active only.
   * Single paginated query (LIMIT/OFFSET) so the renderer can infinite-scroll
   * a "等级排行" without ever firing one query per member. Ties break by older
   * join time first, so equal-level members keep a stable order across pages.
   */
  async listMembersByLevel(groupCode: bigint, limit = 100, offset = 0): Promise<GroupMember[]> {
    const rows = await this.qq.query(
      `SELECT ${await this.selectColumns()} FROM group_member3
       WHERE "60001" = ? AND ("64016" = 0 OR "64016" IS NULL)
       ORDER BY ${await this.levelColumn()} DESC, "64007" ASC
       LIMIT ? OFFSET ?`,
      [groupCode, limit, offset],
    );
    return rows.map(rowToMember);
  }

  /**
   * List all groups a specific user belongs to.
   */
  async listUserGroups(uid: string, limit = 100, offset = 0): Promise<GroupMember[]> {
    const rows = await this.qq.query(
      `SELECT ${await this.selectColumns()} FROM group_member3 WHERE "1000" = ? AND ("64016" = 0 OR "64016" IS NULL) LIMIT ? OFFSET ?`,
      [uid, limit, offset],
    );
    return rows.map(rowToMember);
  }
  async selfJoinTimes(uid: string, uin: string) {
    const rows = await this.qq.query(
      `SELECT "60001","64007","1000" FROM group_member3
       WHERE (("1000"=? AND "1000"!='') OR (("1000"='' OR "1000" IS NULL) AND "1002"=?))
       AND ("64016"=0 OR "64016" IS NULL) LIMIT 20001`,
      [uid, BigInt(uin)],
    );
    if (rows.length > 20000) throw new Error('本人群成员记录过多，请缩小资料来源后重试');
    const times = new Map<string, { time: number; exact: boolean }>();
    for (const row of rows) {
      const code = String(row[0]),
        time = Number(row[1]),
        exact = Boolean(uid && row[2] === uid);
      const previous = times.get(code);
      if (
        time > 0 &&
        (!previous ||
          (exact && !previous.exact) ||
          (exact === previous.exact && time > previous.time))
      )
        times.set(code, { time, exact });
    }
    return Object.fromEntries([...times].map(([code, value]) => [code, value.time]));
  }

  /**
   * Lightweight member scan for relation-graph aggregation: only uid / uin /
   * nick / card / memberLevel, no JOIN and no ORDER BY (the relation graph
   * aggregates by uid and doesn't care about order), so it's much cheaper than
   * {@link listMembersInGroup} when sweeping every group.
   */
  async listMemberBriefsInGroup(
    groupCode: bigint,
    limit = 5000,
  ): Promise<Array<{ uid: string; uin: string; nick: string; card: string; memberLevel: number }>> {
    const rows = await this.qq.query(
      `SELECT "1000","1002","20002","64003",${await this.levelColumn()} FROM group_member3 WHERE "60001" = ? AND ("64016" = 0 OR "64016" IS NULL) LIMIT ?`,
      [groupCode, limit],
    );
    return rows.map((row) => ({
      uid: String(row[0] ?? ''),
      uin: row[1] === null || row[1] === undefined ? '' : String(row[1]),
      nick: String(row[2] ?? ''),
      card: String(row[3] ?? ''),
      memberLevel: Number(row[4] ?? 0),
    }));
  }

  /** 分析可选名册包含在群与退群记录，不套用当前成员过滤或分页上限。 */
  async listAnalysisMembers(
    groupCode: bigint,
  ): Promise<Array<{ uid: string; uin: string; nick: string; card: string }>> {
    const rows = await this.qq.query(
      `SELECT "1000","1002","20002","64003" FROM group_member3 WHERE "60001" = ?`,
      [groupCode],
    );
    return rows.map((row) => ({
      uid: String(row[0] ?? ''),
      uin: row[1] == null || String(row[1]) === '0' ? '' : String(row[1]),
      nick: String(row[2] ?? ''),
      card: String(row[3] ?? ''),
    }));
  }

  /**
   * 全群成员的「入群时间快照」—— 小团体分析的原料：谁的入群时间挨得近，谁就是一伙的。
   *
   * 只要 uid / uin / 昵称 / 入群时间（64007）/ 最后发言（64008）/ 等级（64035），
   * 不带 JOIN、不带 ORDER BY —— 成团在内存里按时间排序算，SQL 侧越简单越好。
   * 只取在群成员（64016 = 0 / null），退群的旧行不算一次「入群」。
   */
  async listMemberJoinBriefs(
    groupCode: bigint,
    limit = 5000,
  ): Promise<
    Array<{
      uid: string;
      uin: string;
      nick: string;
      card: string;
      joinTime: number;
      lastSpeakTime: number;
      memberLevel: number;
    }>
  > {
    const rows = await this.qq.query(
      `SELECT "1000","1002","20002","64003","64007","64008",${await this.levelColumn()}
       FROM group_member3
       WHERE "60001" = ? AND ("64016" = 0 OR "64016" IS NULL)
       LIMIT ?`,
      [groupCode, BigInt(limit)],
    );
    return rows.map((row) => ({
      uid: String(row[0] ?? ''),
      uin: row[1] === null || row[1] === undefined ? '' : String(row[1]),
      nick: String(row[2] ?? ''),
      card: String(row[3] ?? ''),
      joinTime: Number(row[4] ?? 0),
      lastSpeakTime: Number(row[5] ?? 0),
      memberLevel: Number(row[6] ?? 0),
    }));
  }

  /**
   * Single sweep over **every** active membership in the local member table.
   *
   * Cross-group aggregations (年度报告「还没加好友的同路人」等) need the member
   * set of many groups at once. Doing that with one query per group multiplies
   * latency on a table that's already scanned without an index; one bounded
   * scan over `group_member3` returns the whole picture in a single pass. No
   * JOIN and no ORDER BY — the caller groups rows by `groupCode` itself.
   * `memberFlag` active rows only (64016 = 0 / null), same rule as the
   * per-group briefs above.
   */
  async listAllActiveMemberBriefs(
    limit = 200000,
  ): Promise<Array<{ groupCode: bigint; uid: string; uin: string; nick: string; card: string }>> {
    const rows = await this.qq.query(
      `SELECT "60001","1000","1002","20002","64003"
       FROM group_member3
       WHERE ("64016" = 0 OR "64016" IS NULL)
       LIMIT ?`,
      [limit],
    );
    return rows.map((row) => ({
      groupCode: toBigint(row[0]),
      uid: String(row[1] ?? ''),
      uin: row[2] === null || row[2] === undefined ? '' : String(row[2]),
      nick: String(row[3] ?? ''),
      card: String(row[4] ?? ''),
    }));
  }

  /**
   * Search group members by uin or nickname across ALL groups. `group_member3`
   * has no index on 1002/20002, so this is a single bounded scan of the member
   * table (tens of thousands of rows) — cheap enough for a search dropdown.
   * Only active members (64016 = 0) are considered. `total` counts every match
   * for the paginated "more" modal.
   */
  async searchMembers(
    keyword: string,
    limit = 20,
    offset = 0,
    options: { includeHistorical?: boolean; includeCards?: boolean } = {},
  ): Promise<{ items: GroupMemberSearchHit[]; total: number }> {
    const needle = keyword.trim();
    if (!needle) return { items: [], total: 0 };
    const like = `%${escapeLike(needle)}%`;
    const fields = [
      'CAST("1002" AS TEXT)',
      '"20002"',
      ...(options.includeCards ? ['"64003"'] : []),
    ];
    const where =
      `(${fields.map((field) => `${field} LIKE ? ESCAPE '\\'`).join(' OR ')})` +
      (options.includeHistorical ? '' : ` AND ("64016" = 0 OR "64016" IS NULL)`);
    const params = fields.map(() => like);
    const [countRows, rows] = await Promise.all([
      this.qq.query(`SELECT COUNT(*) FROM group_member3 WHERE ${where}`, params),
      this.qq.query(
        `SELECT "60001","1000","1002","20002","64003" FROM group_member3
         WHERE ${where}
         ORDER BY CASE
           WHEN CAST("1002" AS TEXT) = ? OR "20002" = ? COLLATE NOCASE THEN 0
           WHEN CAST("1002" AS TEXT) LIKE ? ESCAPE '\\' OR "20002" LIKE ? ESCAPE '\\' THEN 1
           ELSE 2 END, "60001" ASC, "1000" ASC
         LIMIT ? OFFSET ?`,
        [
          ...params,
          needle,
          needle,
          `${escapeLike(needle)}%`,
          `${escapeLike(needle)}%`,
          BigInt(limit),
          BigInt(offset),
        ],
      ),
    ]);
    return {
      items: rows.map((row) => ({
        groupCode: String(row[0] ?? ''),
        uid: String(row[1] ?? ''),
        uin: row[2] === null || row[2] === undefined ? '' : String(row[2]),
        nick: String(row[3] ?? ''),
        card: String(row[4] ?? ''),
      })),
      total: Number(countRows[0]?.[0] ?? 0),
    };
  }

  /**
   * Search ONE group's members by group card (64003) / nick (20002) / uin (1002).
   *
   * The chat page used to search only the member pages it had already paged in,
   * so a member sitting on page 5 was unfindable until every earlier page had
   * been fetched (and the empty container meant no scroll to trigger more). This
   * searches server-side scoped by 60001, so pagination sees the whole group.
   *
   * Active members only (64016 = 0 / null), same rule as
   * {@link listMembersInGroup}.
   */
  async searchMembersInGroup(
    groupCode: bigint,
    keyword: string,
    limit = 30,
    offset = 0,
  ): Promise<{ items: GroupMember[]; total: number }> {
    const needle = keyword.trim();
    if (!needle) return { items: [], total: 0 };
    const like = `%${escapeLike(needle)}%`;
    const active = `"60001" = ? AND ("64016" = 0 OR "64016" IS NULL)`;
    const order = `"64003" ASC, "20002" ASC, "1000" ASC`;
    const pinyin = createPinyinMatcher(needle);
    if (pinyin) {
      // 只读取检索字段，匹配并分页后再读取完整成员资料。
      const candidates = await this.qq.query(
        `SELECT rowid, "64003", "20002",
          CASE WHEN "64003" = ? COLLATE NOCASE OR "20002" = ? COLLATE NOCASE THEN 4
            WHEN "64003" LIKE ? ESCAPE '\\' OR "20002" LIKE ? ESCAPE '\\' THEN 3
            ELSE 0 END
          FROM group_member3 WHERE ${active} ORDER BY ${order}, rowid`,
        [needle, needle, like, like, groupCode],
      );
      const ranked = candidates.flatMap(([rowid, card, nick, literal]) => {
        const rank =
          Number(literal) ||
          pinyin.rankWithPreferredName(String(card || nick || ''), String(nick ?? ''));
        return rank ? [{ rowid, rank }] : [];
      });
      ranked.sort((a, b) => b.rank - a.rank);
      const page = ranked.slice(offset, offset + limit).map(({ rowid }) => rowid!);
      if (!page.length) return { items: [], total: ranked.length };
      const rows = await this.qq.query(
        `SELECT rowid, ${await this.selectColumns()} FROM group_member3
          WHERE ${active} AND rowid IN (${page.map(() => '?').join(',')})`,
        [groupCode, ...page],
      );
      const byId = new Map(rows.map(([rowid, ...fields]) => [rowid, rowToMember(fields)]));
      return {
        items: page.flatMap((id) => {
          const item = byId.get(id);
          return item ? [item] : [];
        }),
        total: ranked.length,
      };
    }
    const where =
      active +
      ` AND (CAST("1002" AS TEXT) LIKE ? ESCAPE '\\' OR "20002" LIKE ? ESCAPE '\\'` +
      ` OR "64003" LIKE ? ESCAPE '\\')`;
    const [countRows, rows] = await Promise.all([
      this.qq.query(`SELECT COUNT(*) FROM group_member3 WHERE ${where}`, [
        groupCode,
        like,
        like,
        like,
      ]),
      this.qq.query(
        `SELECT ${await this.selectColumns()} FROM group_member3
         WHERE ${where}
         ORDER BY ${order}
         LIMIT ? OFFSET ?`,
        [groupCode, like, like, like, BigInt(limit), BigInt(offset)],
      ),
    ]);
    return {
      items: rows.map(rowToMember),
      total: Number(countRows[0]?.[0] ?? 0),
    };
  }

  /**
   * Get a single member's info.
   */
  async getMember(groupCode: bigint, uid: string): Promise<GroupMember | null> {
    const rows = await this.qq.query(
      `SELECT ${await this.selectColumns()} FROM group_member3 WHERE "60001" = ? AND "1000" = ? LIMIT 1`,
      [groupCode, uid],
    );
    if (rows.length === 0) return null;
    return rowToMember(rows[0]!);
  }

  /**
   * Batch-fetch members by uid in a single query. Used to resolve message
   * senders that fall outside the paginated member list without firing one
   * query per uid. Returns only the members found (no nulls / ordering).
   */
  async getMembersByUids(groupCode: bigint, uids: string[]): Promise<GroupMember[]> {
    const unique = [...new Set(uids.filter((uid) => uid))];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(',');
    const rows = await this.qq.query(
      `SELECT ${await this.selectColumns()} FROM group_member3 WHERE "60001" = ? AND "1000" IN (${placeholders})`,
      [groupCode, ...unique],
    );
    return rows.map(rowToMember);
  }

  /**
   * Batch-fetch members by uin (QQ number) in a single query.
   * Used for group-receipt payer lookup where wire data carries numeric uin.
   */
  async getMembersByUins(groupCode: bigint, uins: bigint[]): Promise<GroupMember[]> {
    const unique = [...new Set(uins.filter((u) => u > 0n))];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(',');
    const rows = await this.qq.query(
      `SELECT ${await this.selectColumns()} FROM group_member3 WHERE "60001" = ? AND "1002" IN (${placeholders})`,
      [groupCode, ...unique],
    );
    return rows.map(rowToMember);
  }

  close(): void {
    this.qq.close();
  }
}

function rowToMember(row: SqlRow): GroupMember {
  return {
    groupCode: toBigint(row[0]),
    uid: String(row[1] ?? ''),
    uin: toBigint(row[2]),
    card: String(row[3] ?? ''),
    nick: String(row[4] ?? ''),
    joinTime: Number(row[5] ?? 0),
    lastSpeakTime: Number(row[6] ?? 0),
    muteUntil: Number(row[7] ?? 0),
    adminFlag: Number(row[8] ?? 0),
    memberFlag: Number(row[9] ?? 0),
    customTitle: String(row[10] ?? ''),
    memberLevel: Number(row[11] ?? 0),
  };
}

function toBigint(v: SqlValue | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

function escapeLike(s: string): string {
  // 前缀必须是一个真的反斜杠 —— 否则 `%` / `_` 在 LIKE 里仍是通配符
  // （搜「a_b」会连「axb」一起匹配，搜「%」等于全表命中）。
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
