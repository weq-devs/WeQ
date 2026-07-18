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
 *   • OLD is a REAL message — its 40800 first element is NOT a gray-tip
 *     (elementType ≠ 8). This is the load-bearing narrowing: if OLD is already a
 *     gray-tip, the real content never existed on this machine (a placeholder
 *     stub for un-fetched history, an offline-period recall, or a row QQ is
 *     backfilling from the server) — cancelling that write saves nothing and
 *     actively breaks QQ's lazy backfill, which is what made "nearby normal
 *     messages get flagged as admin-recalled". So we only ever touch a row that
 *     still holds real content.
 *   • AND that same write turns it INTO a recall gray-tip — NEW's 40800 first
 *     element IS a gray-tip (elementType = 8), OR the (5,4) type flip is
 *     happening (belt-and-suspenders for a settle write that only moves the type
 *     columns). Note a recall can settle as 2/1 with a gray-tip body, NOT always
 *     5/4 — so "first element = 8" is the primary test, not the type columns.
 *
 *     Both the recall-catches-all and the no-false-positives claims are measured
 *     on the live DB: db/test/scan_recall_signature.ts (recall set ⊆ {first
 *     element = 8}, miss-bound = 0 across all three tables) +
 *     db/test/scan_recall_anomaly.ts (normal messages are overwhelmingly first
 *     element 01/02/07; the other gray-tips — 戳一戳 5/12, system 5/8, 精华 5/1 —
 *     arrive as INSERTs, never as a real-message→gray-tip UPDATE, so the OLD≠8
 *     premise keeps them out).
 *
 *     NOT guarded (deliberately), each a former false-positive source:
 *   • `NEW.40800 IS NOT OLD.40800` (any body rewrite) — blocked edits, media
 *     rkey backfill, placeholder-stub completion, AND server backfill writing
 *     real content (the last one is what recalled nearby innocent messages).
 *   • `NEW.40900 IS NOT OLD.40900` (forward/reply preview cache) — QQ lazily
 *     backfills it from the server; recall never writes it (audited 0→0). Guarding
 *     it only stopped WeQ from ever seeing merged-forward content.
 *
 * WeQ's own delete/restore (writeMsgType → 40011/40012 only, never 5/4, never
 * 40800/40002) is therefore NOT blocked.
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

/**
 * One recorded recall, read back from the `weq_recall_log` table the trigger
 * writes to. This is the read side of the anti-recall feature: the trigger
 * (below) records every recall it intercepts; {@link AntiRecallDb.listRecalls}
 * reads them so the UI can flag "this message was recalled — by whom".
 *
 * The original message itself is NOT here — the trigger cancels QQ's recall in
 * place, so the real row survives untouched in the message table and renders
 * normally. `origBody` (the pre-recall body blob) is kept in the log purely as a
 * lossless backstop and is intentionally not surfaced here.
 */
export interface RecallLogRow {
  /** Recalled message's 40001 (msgId), as a decimal string. */
  msgid: string;
  /** Conversation key: peer uid (c2c/dataline) or group code (group). */
  conv: string;
  /** Which table it came from. */
  kind: AntiRecallKind;
  /** Original author's uid (OLD.40020). */
  senderUid: string;
  /**
   * Who performed the recall (extracted from the recall gray-tip). Equals
   * {@link senderUid} for a self-recall; differs when an admin recalled someone
   * else's message. May be '' if extraction failed.
   */
  revokeUid: string;
  /** Original message seq (OLD.40003), as a decimal string. */
  origSeq: string;
  /** When the recall was intercepted (unix seconds). */
  recallTs: number;
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
  revoke_uid  TEXT,      -- 操作者(谁撤的)，从 NEW.40800 的 baa517(47703) 提取；自撤=sender，他撤=管理员
  orig_seq    INTEGER,   -- OLD.40003
  recall_ts   INTEGER,   -- 撤回发生时刻(unix秒)
  orig_body   BLOB,      -- OLD.40800 原文(无损保底)
  graytip_done INTEGER DEFAULT 0     -- WeQ JS 是否已补插灰条（0=待补插，轮询游标用）
)`;

/**
 * 从 NEW.40800（撤回灰条 protobuf）提取**操作者（谁撤的）**uid 的 SQL 表达式。
 *
 * ⚠️ 字段易反，已用真库坐实（diag_recall_operator.ts，group 他撤样本 12/12 一致）：
 *   • baa517 (field 47703) = **操作者 / 谁撤的**  ← 就是这里要的 revoke_uid
 *   • c2a517 (field 47704) = **原发送者**（恒等于 OLD.40020 原作者）
 * 自撤时两者相等，所以旧代码误抽 c2a517 也“看起来对”；但管理员撤他人时 c2a517 恒
 * ==40020 → sameSender 恒 true → UI 误显示「对方撤回」。故必须抽 baa517。
 *
 * 抽取：tag(3B) + `+1` 跳过 len 字节(0x18=24) → uid 恒 24B。找不到(instr=0)取空串。
 * 真库覆盖率 100%（scan_recall_signature.ts：baa517 与 c2a517 均覆盖整个撤回集合）。
 */
const REVOKE_UID_EXPR =
  `CASE WHEN instr(NEW."40800", X'baa517') > 0` +
  ` THEN CAST(substr(NEW."40800", instr(NEW."40800", X'baa517') + 4, 24) AS TEXT)` +
  ` ELSE '' END`;

/**
 * SQL 判定：`alias`(OLD/NEW) 行的 40800 **首个 element 是灰条**（elementType=8）。
 *
 * 40800 里首个 element 的 field 45002(elementType) wire tag = X'd0fc15'，其值恒为
 * 单字节（类型编号 1~8 < 128）。定位 tag 后 `+3` 跳过 3B tag、切 1 字节 == X'08'。
 * 与 {@link REVOKE_UID_EXPR} 同招（instr+substr），不解完整 protobuf。
 *
 * 这是收窄判据的基石。真库全量扫描（scan_recall_signature.ts / scan_recall_anomaly.ts）：
 *   • 撤回集合(5/4 ∪ c2a517) ⊆ {首元素=8}，漏判上界 = 0 → NEW 首元素=8 抓撤回不漏。
 *   • 正常消息首元素压倒性是 01(文本)/02(图)/07(引用)，08 单独一档 → OLD≠8 前提稳固。
 *   • 撤回可 settle 成 2/1（非 5/4！你上次审计撤的那条 msg=…592563 就是 2/1+灰条），
 *     故用「首元素=8」比旧的「5/4」更可靠（5/4 会漏这类，首元素=8 抓得住）。
 */
function firstElemIsGrayTip(alias: 'OLD' | 'NEW'): string {
  const body = `${alias}."40800"`;
  return `(instr(${body}, X'd0fc15') > 0 AND substr(${body}, instr(${body}, X'd0fc15') + 3, 1) = X'08')`;
}

/**
 * Build the `CREATE TRIGGER` statement for one table, gated on the given
 * conversation ids. `ids` must be non-empty — the caller drops (not creates)
 * the trigger for tables with no selection.
 *
 * ── 判据（收窄版，真库数据驱动，见上方 firstElemIsGrayTip）──────────────────────
 * FIRE（拦截+RAISE）当且仅当，一次 UPDATE 把「真消息就地改写成撤回灰条」：
 *   • OLD.40002 IS NEW.40002        —— msgRandom 不变，放行 WeQ 自己的编辑。
 *   • 会话命中用户勾选集。
 *   • NOT firstElemIsGrayTip(OLD)   —— OLD 是**真消息**（首元素≠8）。这是关键：
 *       若 OLD 已是灰条（占位空 stub / 离线期撤回 / backfill 目标），本机从没有过真
 *       内容，拦它毫无意义且会破坏 QQ 的懒加载 backfill —— 一律放行。
 *   • firstElemIsGrayTip(NEW) 或 5/4 翻转 —— 本次写正把它变成撤回灰条。
 *
 * 相比旧判据（body 变 OR 900 变 OR 5/4）去掉了两个误伤源：
 *   • `NEW.40800 IS NOT OLD.40800`：任何 body 改写都拦 → 误伤编辑 / rkey 回填 /
 *     占位空补写 / backfill 写真内容（后者还导致「附近正常消息被误判管理员撤回」）。
 *   • `NEW.40900 IS NOT OLD.40900`：拦转发/引用缓存回填 → WeQ 看不到合并转发。
 * 真库量化：撤回召回 100%(漏判上界 0)，正常消息零结构性误伤（其它灰条走 INSERT 或
 * OLD 本就是灰条，均不满足「OLD 真消息 → NEW 灰条」）。
 *
 * ── 记录门槛：revokeUid 为空则不入库 ─────────────────────────────────────────
 * INSERT 用 `... SELECT ... WHERE <revokeUid> <> ''`：抽不到撤回者就**只拦不记**，
 * 避免把没有操作者的行记成假「管理员撤回」。RAISE 无条件执行（保原文优先，uid 可能
 * 后到）；记录是次要的，宁缺毋滥。收窄后 backfill 已不会 fire，此门是双保险。
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
  AND NOT ${firstElemIsGrayTip('OLD')}
  AND (
    ${firstElemIsGrayTip('NEW')}
    OR (NEW."40011" = 5 AND NEW."40012" = 4
        AND (IFNULL(OLD."40011", -1) <> 5 OR IFNULL(OLD."40012", -1) <> 4))
  )
BEGIN
  -- ① 记录一笔（无损保底：原文 blob + 谁发的 + 谁撤的 + seq + 时刻）。
  --    撤回是同一条消息的多次就地 UPDATE，每击都命中；msgid 是主键 + OR IGNORE →
  --    同一条被撤消息只留一行。WHERE revoke_uid<>'' 是最后门槛：抽不到撤回者就只拦
  --    不记，绝不写成假「管理员撤回」。WeQ JS 轮询这张表补插灰条。
  INSERT OR IGNORE INTO ${RECALL_LOG_TABLE}
    (msgid, conv, table_kind, sender_uid, revoke_uid, orig_seq, recall_ts, orig_body)
    SELECT OLD."40001", CAST(OLD."${spec.filterCol}" AS TEXT), '${spec.kind}',
           OLD."40020", ${REVOKE_UID_EXPR}, OLD."40003", strftime('%s','now'), OLD."40800"
    WHERE ${REVOKE_UID_EXPR} <> '';
  -- ② 取消这次撤回的 UPDATE，原消息原地保留。
  --    ⚠️ 灰条补插绝不能在这里做「INSERT 同表」——已验证：QQ 单事务多击 UPDATE 下，
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
   * Read the recorded recalls for one conversation, newest-first.
   *
   * The `weq_recall_log` table only exists once the trigger has been installed
   * at least once (see {@link ensureRecallLogSchema}); before that a plain
   * SELECT would fail with "no such table". So we probe `sqlite_master` first
   * and return `[]` when the table is absent — a user who never enabled
   * anti-recall simply has no recalls, not an error.
   *
   * Column order matches the SELECT list; `query` returns positional rows.
   */
  async listRecalls(kind: AntiRecallKind, conv: string): Promise<RecallLogRow[]> {
    const exists = await this.qq.query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
      [RECALL_LOG_TABLE],
    );
    if (exists.length === 0) return [];

    const rows = await this.qq.query(
      `SELECT msgid, conv, table_kind, sender_uid, revoke_uid, orig_seq, recall_ts
        FROM ${RECALL_LOG_TABLE}
        WHERE table_kind = ? AND conv = ?
        ORDER BY recall_ts DESC`,
      [kind, conv],
    );
    return rows.map((r) => ({
      msgid: String(r[0]),
      conv: String(r[1]),
      kind: String(r[2]) as AntiRecallKind,
      senderUid: String(r[3] ?? ''),
      revokeUid: String(r[4] ?? ''),
      origSeq: String(r[5] ?? ''),
      recallTs: Number(r[6] ?? 0),
    }));
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
