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
 *   • a QQ-closed guard around every write: the triggers live in QQ's schema and
 *     QQ only re-reads the schema on boot, so installing while QQ runs both risks
 *     the DB lock and wouldn't take effect until restart anyway.
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

import { AntiRecallDb, type AntiRecallTarget, type AntiRecallTriggerInfo } from '@weq/db';
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

  /** Flip the master switch, then reconcile triggers to match. Persists. */
  async setEnabled(enabled: boolean): Promise<AntiRecallStatus> {
    this.config = { ...this.config, enabled };
    this.persist();
    await this.applyTriggers();
    return this.getStatus();
  }

  /** Replace the protected-conversation set, then reconcile. Persists. */
  async setTargets(targets: AntiRecallTarget[]): Promise<AntiRecallStatus> {
    // Drop empty ids and de-dup by (kind,id) so the trigger's IN-list is clean.
    const seen = new Set<string>();
    const clean: AntiRecallTarget[] = [];
    for (const t of targets) {
      if (!t.id) continue;
      const key = `${t.kind}:${t.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push({ kind: t.kind, id: t.id });
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
   * ⚠️ Refuses while QQ is running — the schema change needs the write lock and
   *    wouldn't take effect until QQ restarts anyway. The renderer surfaces
   *    `qqRunning` so the user knows to close QQ; the config is still persisted,
   *    so the next apply (or an explicit re-toggle after closing QQ) installs it.
   */
  async applyTriggers(): Promise<void> {
    if (this.isQqRunning()) {
      throw new AntiRecallQqRunningError();
    }
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
          ? parsed.targets.filter(
              (t): t is AntiRecallTarget =>
                !!t && typeof t.id === 'string' &&
                (t.kind === 'c2c' || t.kind === 'group' || t.kind === 'dataline'),
            )
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

/** Thrown by {@link AntiRecallService.applyTriggers} when QQ is still running. */
export class AntiRecallQqRunningError extends Error {
  readonly code = 'QQ_RUNNING' as const;
  constructor() {
    super('QQ 正在运行，无法安装/更新防撤回触发器。请完全退出 QQ 后重试。');
    this.name = 'AntiRecallQqRunningError';
  }
}
