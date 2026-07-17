/**
 * Anti-recall — the SQL-trigger layer that defeats QQ message recall in place.
 *
 * ── How QQ recall works on disk ──────────────────────────────────────────────
 * A recall is NOT a delete: QQ rewrites the original message row IN PLACE. Two
 * writes actually happen (proven by probing the live DB, see
 * db/test/anti_recall_trigger.ts + inspect_revoke_rows.ts):
 *   1. the 40800 body (message content) is overwritten with a revoke gray-tip,
 *      while 40011/40012 (type) still hold the original values;
 *   2. 40011/40012 are flipped to (5, 4) — the exclusive recall fingerprint.
 * Column 40002 (msgRandom) is left UNTOUCHED across both writes
 * (db/test/compare_recall_40002.ts).
 *
 * ── The trigger ─────────────────────────────────────────────────────────────
 * We install a `BEFORE UPDATE` trigger that does `SELECT RAISE(IGNORE)` — which
 * silently abandons just that row's UPDATE. QQ's write still returns "success"
 * (no error → no crash), but the original message is left intact on disk, so WeQ
 * (and QQ after a restart) keep reading the real message.
 *
 * The trigger fires only when ALL of these hold:
 *   • `OLD."40002" IS NEW."40002"` — msgRandom UNCHANGED. This is the crucial
 *     "is this a recall or a WeQ edit?" test. QQ's recall never touches 40002;
 *     WeQ's own body edits (C2cMsgDb/GroupMsgDb.updateMsgBody) deliberately bump
 *     40002 to a fresh random, so they slip past this trigger while QQ recall is
 *     caught. Without this guard the trigger would eat WeQ's own edits.
 *   • the row's conversation key is in the user-selected set (session filter):
 *     c2c/dataline filter on 40021 (peer uid), group filters on 40027 (群号).
 *   • the update actually rewrites message content — 40800 (body) OR 40900
 *     (forward/reply cache) changed, OR the (5,4) type flip is happening. The
 *     5/4 clause is a belt-and-suspenders guard for recall's second write (which
 *     only touches the type columns, the body having already been blocked).
 *
 * WeQ's own delete/restore (writeMsgType → 40011/40012 only, never 5/4, never
 * 40800/40900/40002) is therefore NOT blocked.
 *
 * ── Scope & lifecycle ───────────────────────────────────────────────────────
 * One trigger per message table, named `weq_anti_recall_{c2c,group,dataline}`.
 * {@link AntiRecallDb.reconcile} is the single entry point: given the full set
 * of selected conversations it (re)creates the triggers for tables that have a
 * selection and drops the triggers for tables that don't — so toggling the
 * feature off, or changing the selection, is just another `reconcile` call.
 *
 *   ⚠️  Writes hit QQ's live nt_msg.db. Prefer to run with QQ CLOSED: QQ only
 *       re-reads the schema on boot, so a freshly installed trigger reliably
 *       takes effect after the next QQ start. The service layer enforces this.
 *
 * ── Reserved for a later round (intentionally NOT implemented here) ──────────
 * Right now the trigger only *cancels* the recall. A future round wants a
 * customisable hook — e.g. instead of a bare cancel, insert a "对方尝试撤回以上消息"
 * gray tip, or run a user-defined action. That needs a crafted 40800 blob that
 * respects the UNIQUE indexes and is a separate, larger step; the trigger shape
 * here (a WHEN-gated BEFORE UPDATE) is deliberately the right seam to hang it on.
 */

import type { DatabaseAlgorithms, NtHelperBinding } from '@weq/native';
import { QqDb } from '../qq_db';

/** Which chat type a selected conversation belongs to. */
export type AntiRecallKind = 'c2c' | 'group' | 'dataline';

/** One conversation the user chose to protect from recall. */
export interface AntiRecallTarget {
  kind: AntiRecallKind;
  /** Conversation key: peer uid (c2c/dataline) or group code (group). */
  id: string;
}

/** A currently-installed trigger, as reported by {@link AntiRecallDb.status}. */
export interface AntiRecallTriggerInfo {
  /** Trigger name, e.g. `weq_anti_recall_c2c`. */
  name: string;
  /** Table it guards. */
  table: string;
}

interface TableSpec {
  kind: AntiRecallKind;
  table: string;
  /** Column holding the conversation key for the session filter. */
  filterCol: string;
  /**
   * True when `filterCol` stores its key as an INTEGER (group's 40027 群号),
   * false when it's TEXT (c2c/dataline's 40021 peer uid).
   *
   * This is load-bearing, and the reason group recall silently slipped past the
   * trigger for a while: inside a trigger, `OLD."col"` is an EXPRESSION and does
   * NOT carry the table column's affinity (proven with an audit trigger on the
   * live DB — db/test/diag_audit_trigger.ts). So `OLD."40027" IN ('673646675')`
   * compares INTEGER 673646675 against TEXT '673646675', which SQLite deems
   * unequal (different storage classes) → the WHEN never matched → recall went
   * through. A plain `SELECT … WHERE "40027" IN ('…')` DOES match (the real
   * table column applies NUMERIC affinity), which is exactly why every SELECT
   * probe misled us. Fix: emit the IN-list as bare integer literals for numeric
   * filter columns so it's INTEGER-vs-INTEGER. TEXT columns keep quoted string
   * literals.
   */
  filterNumeric: boolean;
  trigger: string;
}

/** The three message tables and how each is filtered by conversation. */
const TABLE_SPECS: readonly TableSpec[] = [
  { kind: 'c2c', table: 'c2c_msg_table', filterCol: '40021', filterNumeric: false, trigger: 'weq_anti_recall_c2c' },
  { kind: 'group', table: 'group_msg_table', filterCol: '40027', filterNumeric: true, trigger: 'weq_anti_recall_group' },
  { kind: 'dataline', table: 'dataline_msg_table', filterCol: '40021', filterNumeric: false, trigger: 'weq_anti_recall_dataline' },
] as const;

/** Quote a value as a SQL string literal (single quotes, doubled to escape). */
function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * Render one conversation id as a SQL literal for the IN-list, matching the
 * filter column's storage class (see {@link TableSpec.filterNumeric}).
 *
 * For a numeric column we emit a BARE INTEGER. A group id is always all-digits;
 * anything else (e.g. a stray `u_…` uid the renderer mis-tagged as group) can't
 * live in an INTEGER 40027 anyway, so we drop it rather than emit a quoted value
 * that would (a) re-introduce the affinity mismatch and (b) never match. TEXT
 * columns keep quoted string literals.
 */
function sqlLiteral(id: string, numeric: boolean): string | null {
  if (!numeric) return sqlStr(id);
  return /^[0-9]+$/.test(id) ? id : null;
}

// ── 补插灰条 + 记录表的常量 ──────────────────────────────────────────────────

/** 撤回记录表名（我们自己的表，QQ 不认识、不会碰）。 */
const RECALL_LOG_TABLE = 'weq_recall_log';

/**
 * 撤回记录表 DDL。见 docs/anti-recall.md「记录表」。
 *
 * msgid 设为 PRIMARY KEY —— trigger 用 `INSERT OR IGNORE` 写入，QQ 撤回是**单事务
 * 3 连击 UPDATE**（body 逐步 52→88→…），每击都命中 trigger，靠 msgid 主键天然去重，
 * 同一条被撤消息只留一行。recall_ts 用首次命中时刻。
 */
const RECALL_LOG_DDL = `CREATE TABLE IF NOT EXISTS ${RECALL_LOG_TABLE} (
  msgid       INTEGER PRIMARY KEY,   -- 被撤消息 40001（去重键）
  conv        TEXT,      -- 会话标识: group=40027 / c2c·dataline=40021
  table_kind  TEXT,      -- 'c2c' | 'group' | 'dataline'
  sender_uid  TEXT,      -- 原作者 OLD.40020
  revoke_uid  TEXT,      -- 撤回者，从 NEW.40800 提取(可能=sender 或 管理员)
  orig_seq    INTEGER,   -- OLD.40003
  recall_ts   INTEGER,   -- 撤回发生时刻(unix秒)
  orig_body   BLOB,      -- OLD.40800 原文(无损保底)
  graytip_done INTEGER DEFAULT 0     -- WeQ JS 是否已补插灰条（0=待补插，轮询游标用）
)`;

/**
 * 从 NEW.40800（撤回灰条 protobuf）提取撤回者 uid 的 SQL 表达式。
 * field 47704 (recallRevokeUid) 的 wire tag = X'c2a517'；uid 恒 24B。
 * `+4` = 跳过 3B tag + 1B len(0x18)。若没定位到（instr=0）则表达式取空串。
 * 见 probe_recall_uid_extract.ts（真库 5/5 稳定切出 u_ 开头 24B）。
 */
const REVOKE_UID_EXPR =
  `CASE WHEN instr(NEW."40800", X'c2a517') > 0` +
  ` THEN CAST(substr(NEW."40800", instr(NEW."40800", X'c2a517') + 4, 24) AS TEXT)` +
  ` ELSE '' END`;

/**
 * Build the `CREATE TRIGGER` statement for one table, gated on the given
 * conversation ids. `ids` must be non-empty — the caller drops (not creates)
 * the trigger for tables with no selection.
 *
 * Returns `null` when, after rendering to storage-class-correct literals, no id
 * survives (e.g. a numeric table handed only non-numeric ids). An empty IN-list
 * would be `IN ()` — a syntax error — so the caller treats null as "nothing to
 * install for this table".
 */
function createTriggerSql(spec: TableSpec, ids: readonly string[]): string | null {
  const inList = ids
    .map((id) => sqlLiteral(id, spec.filterNumeric))
    .filter((lit): lit is string => lit !== null)
    .join(', ');
  if (inList === '') return null;

  return `CREATE TRIGGER IF NOT EXISTS ${spec.trigger}
BEFORE UPDATE ON ${spec.table}
WHEN OLD."40002" IS NEW."40002"
  AND OLD."${spec.filterCol}" IN (${inList})
  AND (
    NEW."40800" IS NOT OLD."40800"
    OR NEW."40900" IS NOT OLD."40900"
    OR (NEW."40011" = 5 AND NEW."40012" = 4
        AND (IFNULL(OLD."40011", -1) <> 5 OR IFNULL(OLD."40012", -1) <> 4))
  )
BEGIN
  -- ① 记录一笔（无损保底：原文 blob + 谁发的 + 谁撤的 + seq + 时刻）。
  --    QQ 撤回是单事务 3 连击 UPDATE，每击都命中；msgid 是主键 + OR IGNORE →
  --    同一条被撤消息只留一行，recall_ts 取首次命中时刻。WeQ JS 轮询这张表补插灰条。
  INSERT OR IGNORE INTO ${RECALL_LOG_TABLE}
    (msgid, conv, table_kind, sender_uid, revoke_uid, orig_seq, recall_ts, orig_body)
    VALUES (OLD."40001", CAST(OLD."${spec.filterCol}" AS TEXT), '${spec.kind}',
            OLD."40020", ${REVOKE_UID_EXPR}, OLD."40003", strftime('%s','now'), OLD."40800");
  -- ② 取消这次撤回的 UPDATE，原消息原地保留。
  --    ⚠️ 灰条补插绝不能在这里做「INSERT 同表」——已验证：QQ 单事务 3 连击下，
  --    RAISE(IGNORE) 会把同事务里补插的 INSERT 一起废掉（连记录表若与补插同体也会没）。
  --    所以补插灰条改由 WeQ JS 轮询 weq_recall_log 后用 appendClonedRow 完成（方案 C）。
  SELECT RAISE(IGNORE);
END`;
}

/**
 * Low-level installer for the anti-recall triggers on one account's nt_msg.db.
 *
 * Stateless beyond the wrapped {@link QqDb}: every method reflects the live
 * schema, so it's safe to call {@link reconcile} repeatedly (idempotent).
 */
export class AntiRecallDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: { dbPath: string; key?: string; algo?: DatabaseAlgorithms }) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /** List the anti-recall triggers currently installed. */
  async status(): Promise<AntiRecallTriggerInfo[]> {
    const rows = await this.qq.query(
      `SELECT name, tbl_name FROM sqlite_master
        WHERE type = 'trigger' AND name LIKE 'weq_anti_recall_%'
        ORDER BY tbl_name`,
    );
    return rows.map((r) => ({ name: String(r[0]), table: String(r[1]) }));
  }

  /**
   * Reconcile the installed triggers to exactly protect `targets`:
   *   • a table with ≥1 selected conversation → its trigger is (re)created with
   *     the current id list (dropped first so the WHEN filter always refreshes);
   *   • a table with no selection → its trigger is dropped.
   * Passing `[]` therefore uninstalls everything (same as {@link uninstall}).
   *
   * Each statement runs on its own write (QqDb.write drops the lock after each),
   * so a mid-way failure leaves a consistent, inspectable state.
   */
  async reconcile(targets: readonly AntiRecallTarget[]): Promise<void> {
    const byKind = new Map<AntiRecallKind, string[]>();
    for (const t of targets) {
      const list = byKind.get(t.kind) ?? [];
      if (t.id) list.push(t.id);
      byKind.set(t.kind, list);
    }

    // 记录表必须先于任何 trigger 存在——trigger body 会 INSERT 进它。幂等。
    const anySelected = [...byKind.values()].some((l) => l.length > 0);
    if (anySelected) {
      await this.ensureRecallLogSchema();
    }

    for (const spec of TABLE_SPECS) {
      const ids = byKind.get(spec.kind) ?? [];
      // Always drop first: refreshing the WHEN id-list means replacing the
      // stored trigger, and DROP-then-CREATE is the only portable way.
      await this.qq.write(`DROP TRIGGER IF EXISTS ${spec.trigger}`);
      if (ids.length > 0) {
        const sql = createTriggerSql(spec, ids);
        // null → no storage-class-valid id survived for this table; leave it
        // dropped rather than emit an `IN ()` syntax error.
        if (sql) await this.qq.write(sql);
      }
    }
  }

  /**
   * 确保记录表存在**且结构最新**。
   *
   * 陷阱：`CREATE TABLE IF NOT EXISTS` 对一张**已存在但结构陈旧**的表是无操作 ——
   * 早期版本建的 weq_recall_log 可能缺 `graytip_done` 等列，直接用会让 trigger 的
   * INSERT 因列不存在而失败（在 QQ 撤回时静默炸）。所以这里先探列：缺任一必需列就
   * DROP 重建。记录表是我们自己的增量辅助数据，重建丢历史无伤（撤回记录本就是往后
   * 累积的），换取 schema 一定正确。
   */
  private async ensureRecallLogSchema(): Promise<void> {
    const required = [
      'msgid', 'conv', 'table_kind', 'sender_uid', 'revoke_uid',
      'orig_seq', 'recall_ts', 'orig_body', 'graytip_done',
    ];
    const info = await this.qq.query(`PRAGMA table_info("${RECALL_LOG_TABLE}")`);
    if (info.length > 0) {
      const have = new Set(info.map((r) => String(r[1])));
      const missing = required.some((c) => !have.has(c));
      if (missing) {
        await this.qq.write(`DROP TABLE IF EXISTS ${RECALL_LOG_TABLE}`);
      }
    }
    await this.qq.write(RECALL_LOG_DDL);
  }

  /** Drop all three anti-recall triggers, whatever the current selection. */
  async uninstall(): Promise<void> {
    for (const spec of TABLE_SPECS) {
      await this.qq.write(`DROP TRIGGER IF EXISTS ${spec.trigger}`);
    }
  }

  /** Drop the cached native connection. Call on account switch / shutdown. */
  close(): void {
    this.qq.close();
  }
}
