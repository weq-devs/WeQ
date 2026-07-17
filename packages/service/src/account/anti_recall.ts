/**
 * AntiRecallService — anti-recall feature bound to the current account.
 *
 * Ties three things together:
 *   • persisted config (per account): master switch + the set of conversations
 *     the user chose to protect. Stored as one JSON file, modeled on
 *     {@link DeletedMsgStore} (load on construct, persist on mutate, silent on
 *     I/O error).
 *   • the SQL-trigger installer {@link AntiRecallDb} (in @weq/db) that actually
 *     writes/drops the `BEFORE UPDATE … RAISE(IGNORE)` triggers on nt_msg.db.
 *   • a `qqRunning` hint alongside every write: install/uninstall works whether
 *     or not QQ is open (each trigger DDL is a short, lock-releasing write), but
 *     QQ may keep serving from its already-open connection's cached schema, so a
 *     freshly (un)installed trigger can take until QQ's next restart to actually
 *     (stop) firing. The renderer surfaces `qqRunning` to warn about exactly that.
 *
 * The renderer drives it through the anti_recall tRPC router:
 *   getConfig → { enabled, targets, installed }   (installed = live trigger set)
 *   setEnabled(enabled)                            → reconcile + persist
 *   setTargets(targets)                            → reconcile + persist
 *
 * Reconciliation is always "make the live triggers match (enabled ? targets:∅)".
 * Disabling is just `reconcile([])`, i.e. drop everything — the selection is kept
 * in config so re-enabling restores it.
 */

import { AntiRecallDb, type AntiRecallTarget, type AntiRecallTriggerInfo, type RecallLogRow } from '@weq/db';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Persisted anti-recall config for one account. */
export interface AntiRecallConfig {
  /** Master switch. When false, no triggers are installed regardless of targets. */
  enabled: boolean;
  /** Conversations the user chose to protect. */
  targets: AntiRecallTarget[];
}

/** What the renderer needs to render the settings panel. */
export interface AntiRecallStatus extends AntiRecallConfig {
  /** Triggers actually present in the DB right now (source of truth for state). */
  installed: AntiRecallTriggerInfo[];
  /** True while QQ is running — installs are deferred / the UI warns to restart. */
  qqRunning: boolean;
}

const DEFAULT_CONFIG: AntiRecallConfig = { enabled: false, targets: [] };

/**
 * 归一化一个 target 的 kind，修复前端对临时会话的误判。
 *
 * 真群号是纯数字，uid 一定是 `u_` 开头。有些临时会话（群临时会话/频道等）chatType
 * 名字里带 'GROUP'，却把 uid 存进 targetUid —— 前端可能把它错标成 group，塞进 group
 * 触发器的 40027(数字) IN 列表，导致永不命中、完全不受保护（已在真实库用
 * diag_dirty_conv.ts 证实这类会话消息都在 c2c_msg_table）。
 *
 * 这里兜底：id 以 `u_` 开头却标了 group 的，一律改回 c2c（走 40021）。既清洗历史脏
 * 配置（load 时自愈），也防前端漏网（setTargets 时再校一遍）。dataline 保持不动——
 * 数据线 id 也是 u_，但它是前端按 chatType 明确判定的，不该被降级成 c2c。
 */
function normalizeTarget(t: AntiRecallTarget): AntiRecallTarget {
  if (t.kind === 'group' && t.id.startsWith('u_')) {
    return { kind: 'c2c', id: t.id };
  }
  return { kind: t.kind, id: t.id };
}

export class AntiRecallService {
  private config: AntiRecallConfig;

  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
    private readonly storePath: string,
  ) {
    this.config = this.load();
  }

  /** Current config + live trigger state + whether QQ is running. */
  async getStatus(): Promise<AntiRecallStatus> {
    const db = this.openDb();
    try {
      const installed = await db.status();
      return {
        enabled: this.config.enabled,
        targets: this.config.targets,
        installed,
        qqRunning: this.isQqRunning(),
      };
    } finally {
      db.close();
    }
  }

  /**
   * The recorded recalls for one conversation, newest-first — read straight from
   * the `weq_recall_log` table the trigger writes to. Empty when the feature was
   * never enabled (the table doesn't exist yet — {@link AntiRecallDb.listRecalls}
   * handles that). Drives the "撤回列表" panel.
   */
  async listRecalls(kind: 'c2c' | 'group', conv: string): Promise<RecallLogRow[]> {
    const db = this.openDb();
    try {
      return await db.listRecalls(kind, conv);
    } finally {
      db.close();
    }
  }

  /**
   * A `msgId → recall info` map for one conversation, so a message page can be
   * tagged in a single DB read instead of one lookup per message. Consumed by
   * {@link MsgService} to attach `recall` to each rendered message.
   */
  async getRecallMap(
    kind: 'c2c' | 'group',
    conv: string,
  ): Promise<Map<string, { revokeUid: string; senderUid: string; recallTs: number }>> {
    const rows = await this.listRecalls(kind, conv);
    const map = new Map<string, { revokeUid: string; senderUid: string; recallTs: number }>();
    for (const r of rows) {
      map.set(r.msgid, { revokeUid: r.revokeUid, senderUid: r.senderUid, recallTs: r.recallTs });
    }
    return map;
  }

  /** Flip the master switch, then reconcile triggers to match. Persists. */
  async setEnabled(enabled: boolean): Promise<AntiRecallStatus> {
    this.config = { ...this.config, enabled };
    this.persist();
    await this.applyTriggers();
    return this.getStatus();
  }

  /** Replace the protected-conversation set, then reconcile. Persists. */
  async setTargets(targets: AntiRecallTarget[]): Promise<AntiRecallStatus> {
    // Normalize (u_ ids can't be group codes), drop empty ids, de-dup by (kind,id)
    // so the trigger's IN-list is clean and every id lands in the right column.
    const seen = new Set<string>();
    const clean: AntiRecallTarget[] = [];
    for (const raw of targets) {
      if (!raw.id) continue;
      const t = normalizeTarget(raw);
      const key = `${t.kind}:${t.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push(t);
    }
    this.config = { ...this.config, targets: clean };
    this.persist();
    await this.applyTriggers();
    return this.getStatus();
  }

  /**
   * Make the live triggers match the current config: install for the selected
   * conversations when enabled, drop everything when disabled (or nothing is
   * selected).
   *
   * Works whether or not QQ is running — each statement is a short write that
   * releases the lock immediately (see QqDb.write). Note only: if QQ is open it
   * may keep firing (or not firing) the old triggers from its cached schema
   * until its next restart, so callers surface `qqRunning` as a heads-up.
   */
  async applyTriggers(): Promise<void> {
    const db = this.openDb();
    try {
      const active = this.config.enabled ? this.config.targets : [];
      await db.reconcile(active);
    } finally {
      db.close();
    }
  }

  /** True when a QQ process is currently running on this machine. */
  private isQqRunning(): boolean {
    try {
      return this.platform.native.ntHelper.getQqProcesses().length > 0;
    } catch {
      // If we can't tell, assume running — safer to defer a schema write than
      // to fight QQ for the lock.
      return true;
    }
  }

  private openDb(): AntiRecallDb {
    return new AntiRecallDb(this.platform.native.ntHelper, {
      dbPath: this.session.msgDbPath,
      key: this.session.context.dbKey,
      algo: this.session.context.algo,
    });
  }

  private load(): AntiRecallConfig {
    try {
      if (!existsSync(this.storePath)) return { ...DEFAULT_CONFIG };
      const parsed = JSON.parse(readFileSync(this.storePath, 'utf-8')) as Partial<AntiRecallConfig>;
      return {
        enabled: parsed.enabled === true,
        targets: Array.isArray(parsed.targets)
          ? parsed.targets
              .filter(
                (t): t is AntiRecallTarget =>
                  !!t && typeof t.id === 'string' &&
                  (t.kind === 'c2c' || t.kind === 'group' || t.kind === 'dataline'),
              )
              .map(normalizeTarget)
          : [],
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify(this.config), 'utf-8');
    } catch {
      /* 持久化失败不应阻断开关本身；下次 apply 时以内存态为准 */
    }
  }
}
