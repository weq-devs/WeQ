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
  trigger: string;
}

/** The three message tables and how each is filtered by conversation. */
const TABLE_SPECS: readonly TableSpec[] = [
  { kind: 'c2c', table: 'c2c_msg_table', filterCol: '40021', trigger: 'weq_anti_recall_c2c' },
  { kind: 'group', table: 'group_msg_table', filterCol: '40027', trigger: 'weq_anti_recall_group' },
  { kind: 'dataline', table: 'dataline_msg_table', filterCol: '40021', trigger: 'weq_anti_recall_dataline' },
] as const;

/** Quote a value as a SQL string literal (single quotes, doubled to escape). */
function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * Build the `CREATE TRIGGER` statement for one table, gated on the given
 * conversation ids. `ids` must be non-empty — the caller drops (not creates)
 * the trigger for tables with no selection.
 */
function createTriggerSql(spec: TableSpec, ids: readonly string[]): string {
  const inList = ids.map(sqlStr).join(', ');
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

    for (const spec of TABLE_SPECS) {
      const ids = byKind.get(spec.kind) ?? [];
      // Always drop first: refreshing the WHEN id-list means replacing the
      // stored trigger, and DROP-then-CREATE is the only portable way.
      await this.qq.write(`DROP TRIGGER IF EXISTS ${spec.trigger}`);
      if (ids.length > 0) {
        await this.qq.write(createTriggerSql(spec, ids));
      }
    }
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
